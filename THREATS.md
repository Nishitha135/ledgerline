# THREATS.md

How the money or the ledger could be broken, what stops it, and what I knowingly left open.
"Test" names the automated test that exercises the defence. The key defences were also checked
by mutation: remove the check, run the tests, see them fail.

## Closed

| # | Threat | Defence | Test |
|---|---|---|---|
| 1 | Two withdrawals race and both pass the balance check | One DB transaction per request. Accounts are locked with SELECT ... FOR UPDATE, balance is read after the lock, check and debit happen under the same lock | race.test.js, ledger.test.js (20 and 30 concurrent withdrawals) |
| 2 | Overdraw past an authorised overdraft limit | Same lock, check against overdraft_limit. DB CHECK (balance >= -overdraft_limit) is a second layer | ledger.test.js overdraft test |
| 3 | Deadlock between A to B and B to A transfers | Locks are always taken in ascending account id order | ledger.test.js opposite transfers |
| 4 | Retry or double click pays twice | Idempotency-Key header, per user. Key row and money movement commit in the same transaction, so a key exists only if the request was fully processed | ledger.test.js, race.test.js |
| 5 | Two copies of the same request arrive at the same instant | pg_advisory_xact_lock on (user, key) makes the second wait, then replay the stored answer. PRIMARY KEY (user_id, key) is the last backstop: without the advisory lock the duplicate is rolled back (no double payment) but answers 500 | race.test.js |
| 6 | Same key reused for a different request (different amount or account) | request_hash is compared. Mismatch is rejected with 422 and moves nothing | ledger.test.js |
| 7 | Request fails halfway (debit written, credit lost) | Everything is in one transaction, any error rolls back all of it | by construction, plus conservation checks after every race test |
| 8 | Money created or destroyed | Double-entry. Every transaction has equal debits and credits, and the sum of all balances is exactly 0 (EXTERNAL goes negative on deposits). Checked from the database after the races | assertLedgerConsistent in helpers.js |
| 9 | Moving another user's money | Ownership is checked on the server for every request. Admin and auditor cannot withdraw or transfer customer money | ledger.test.js authorisation tests |
| 10 | Lock griefing: attacker names a victim's account to make the server lock it | Authorisation is checked with a plain read before any lock is taken | by construction (see getAccount in ledger.js) |
| 11 | Editing or deleting a ledger row to hide a payment | BEFORE UPDATE/DELETE and BEFORE TRUNCATE triggers on ledger_entries, transactions and refused_attempts | ledger.test.js append-only test |
| 12 | Refused attempts disappearing | Every refusal is written to refused_attempts in the same transaction as its idempotency key and shown in the statement | ledger.test.js |
| 13 | Float rounding errors | All amounts are integer paise (BIGINT). Arithmetic is done with BigInt or in SQL | validation test |
| 14 | Garbage input (negative, fractional, huge, string amounts, bad ids) | zod validation before any DB work | validation test |
| 15 | Self-registering as admin | /auth/register always creates a holder. Admin and auditor exist only through the seed script | by construction |
| 16 | Role escalation through a stale token | Role is read from the database on every request, not from the token | by construction |
| 17 | Password guessing | bcrypt, rate limit on login and register, same message and similar timing for unknown email and wrong password | not tested |
| 18 | Attacker piles refused attempts onto a victim's statement | Refusals for someone else's account are recorded against the attacker (account_id empty, the target in the reason), not on the victim's statement. Admin and auditor read them at GET /audit/refused | audit.test.js |
| 19 | A balance quietly drifts from the ledger | GET /audit/reconcile recomputes, in one consistent snapshot, that every transaction nets to zero, all balances sum to 0, and each balance equals its ledger total | audit.test.js |

## Mutation results (defence removed, tests run)

| Removed | Result |
|---|---|
| FOR UPDATE row lock | 4 tests fail. The app check alone is not enough, and the DB CHECK turns the race into 500s instead of overdrafts |
| Advisory lock on the idempotency key | 2 tests fail. Duplicates hit the PRIMARY KEY: no double payment, but a 500 |
| Balance check in the application | 5 tests fail. The DB CHECK still prevents a negative balance, but answers 500 instead of 422 |
| Ownership check on transfer | 1 test fails |
| Ownership check on withdrawal | 1 test fails |
| Entitlement check on deposit | 1 test fails |
| GRANT UPDATE on ledger_entries to the app role | 1 test fails (privileges.test.js). The trigger still blocks the update, the grant layer is what the test checks |

One test was weak at first: the 20-concurrent-withdrawals test passed even without the row lock,
because a cold connection pool made the requests run one after another. The pool is now warmed
and the race is repeated for five rounds.

## Knowingly open

| # | Risk | Why I left it |
|---|---|---|
| A | Whoever holds the database OWNER credentials (including Neon account access) can still disable the triggers and edit the ledger | The application no longer has them: it connects as ledger_app (INSERT and SELECT on the ledger tables, UPDATE only on accounts.balance and replay_count, no TRUNCATE, cannot touch triggers or schema). The owner password is not in the app environment. A hash chain over ledger rows would also expose tampering by the owner. Not built |
| B | idempotency_keys rows can be updated or deleted (they hold replay counts and stored responses, not money) | Money is safe, but the duplicate evidence could be altered |
| C | All deposits and withdrawals lock the single EXTERNAL account row, so they serialise globally | Correct but a throughput limit. Accepted for this scale |
| D | Idempotency keys are kept forever | No expiry job. Accepted for this scale |
| E | A replayed response is the stored JSON, so field order can differ from the first response | Cosmetic (JSONB does not keep key order). Content is identical |
| F | A request that reuses a key with a different body is rejected but not written to refused_attempts | Gap in the audit trail |
| G | Money-moving requests answer 403 for someone else's account but reads answer 404, so account ids can be probed | Ids are sequential anyway |
| H | An admin can deposit any amount into any account with no second approval | No maker-checker flow. The deposit is still a ledger entry with the admin as initiator |
| I | JWTs live for one hour and cannot be revoked early | Role changes still apply at once because the role comes from the database |
| J | Free hosting sleeps when idle, the first request can take about 50 seconds | Cost |
| K | The rate limit covers login and register only, not the money endpoints | Not done yet |

## Not built, on purpose

Multi-currency, scheduled and batch transfers, reversals and refunds, holds and authorisations. A small
system whose balances are always right beats a large one that loses a rupee.
