# API reference

Base URL: `https://ledgerline-5vah.onrender.com`. JSON in, JSON out. Amounts are **integer paise**
(`250050` is ?2,500.50). Ids are returned as strings. Authenticated routes need
`Authorization: Bearer <token>` from `POST /auth/login` (valid for one hour).

## Endpoints

| Method and path | Who may call it | What it does to the money |
|---|---|---|
| `GET /health` | anyone | Nothing. Checks the app and the database. |
| `POST /auth/register` | anyone | Nothing. Creates a user with the **holder** role (never admin or auditor). Rate limited. |
| `POST /auth/login` | anyone | Nothing. Returns a token. Rate limited. |
| `GET /auth/me` | any signed-in user | Nothing. |
| `GET /accounts` | any signed-in user | Nothing. A holder sees own accounts. Admin and auditor see all, including EXTERNAL. |
| `POST /accounts` | admin | Creates an empty account for a holder (`ownerEmail`, `name`, optional `overdraftLimit` in paise). No money moves. |
| `GET /accounts/:id` | owner, admin, auditor | Nothing. Anyone else gets 404. |
| `GET /accounts/:id/statement` | owner, admin, auditor | Nothing. The latest 200 postings and refused attempts, newest first, with the running balance and who initiated each. |
| `POST /accounts/:id/deposit` | holder (own account), admin (any customer account) | Credits the account, debits EXTERNAL. |
| `POST /accounts/:id/withdraw` | holder (own account) | Debits the account, credits EXTERNAL. Refused if it would go below `-overdraftLimit`. |
| `POST /transfers` | holder (from own account) | Debits `fromAccountId`, credits `toAccountId`. Refused if the source would go below `-overdraftLimit`. |
| `GET /audit/refused` | admin, auditor | Nothing. Every refused attempt, including attempts on accounts the caller does not own. `?limit=` up to 1000. |
| `GET /audit/reconcile` | admin, auditor | Nothing. Recomputes the invariants from the ledger in one consistent snapshot. |

The auditor can never move money. An administrator can deposit but cannot withdraw or transfer.

## Money-moving requests

`POST /accounts/:id/deposit` and `/withdraw` take `{"amount": 25050}`.
`POST /transfers` takes `{"fromAccountId": "2", "toAccountId": "3", "amount": 5000}`.
`amount` is an integer from 1 to 1,000,000,000,000 paise.

All three require an **`Idempotency-Key`** header: 8 to 128 characters from letters, digits, `_ . : -`.
Use a fresh random value for each new payment and **reuse the same value to retry**.

```bash
curl -X POST https://ledgerline-5vah.onrender.com/accounts/2/deposit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: pay-2026-11-07-0001" \
  -H "Content-Type: application/json" \
  -d '{"amount": 25050}'
```

Success is `201` with `{"transactionId", "type", "amount", "balance", ...}`. `balance` is the account's
new balance in paise.

### How the key behaves

- Keys are scoped to the user and remembered permanently.
- Same key, same request: the **first answer is returned again** with the header
  `Idempotent-Replayed: true`, and no money moves.
- Same key, different request (another amount or account): `422`, nothing moves.
- Two copies at the same instant: one runs, the other waits and gets the same answer.
- A business refusal (`403`, `404`, `422` insufficient funds) is stored under the key too, so replaying it
  returns the same refusal and is not logged twice.
- Validation errors (`400`) and server errors (`500`) are not stored. Fix the request or retry with the same key.

## Status codes

| Code | Meaning |
|---|---|
| 200, 201 | Done. |
| 400 | Invalid input, or a missing or malformed `Idempotency-Key`. Nothing moved. |
| 401 | Missing, invalid or expired token. |
| 403 | You may not do this (not your account, or your role cannot). Money endpoints record it as a refused attempt. Nothing moved. |
| 404 | Account not found, or (for reads) not yours. |
| 422 | Insufficient funds, or the idempotency key was already used for a different request. Nothing moved. |
| 429 | Too many sign-in or register attempts from one address. |
| 500 | Unexpected error. The transaction was rolled back, so nothing moved. |

## Checking the books

`GET /audit/reconcile` returns `ok: true` only if every transaction's debits equal its credits, all balances
add up to exactly 0, and every account's balance equals the sum of its ledger entries. It also reports the
number of duplicate requests blocked.
