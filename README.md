# LedgerLine

Money movement with a ledger you can prove. Deposits, withdrawals and transfers between accounts,
where money is never created or lost, the same request never moves money twice, and every posting and
every refused attempt is on an append-only record.

- **Live app:** https://ledgerline-5vah.onrender.com
- **Health check:** https://ledgerline-5vah.onrender.com/health
- **Repository:** https://github.com/Nishitha135/ledgerline

The app runs on Render's free tier, which sleeps when idle. The first request after a quiet period can
take about 50 seconds. Open `/health` first and wait for `{"status":"ok"}`.

## Demo accounts (live and after `npm run seed`)

| Role | Email | Password |
|---|---|---|
| Administrator | admin@ledgerline.test | AdminDemo#2026 |
| Account holder | holder@ledgerline.test | HolderDemo#2026 |
| Auditor (read-only) | auditor@ledgerline.test | AuditorDemo#2026 |

These are demo credentials only. Anyone can also register a new account holder on the sign-in page.

## What each role can do

| | Holder | Administrator | Auditor |
|---|---|---|---|
| See accounts and statements | own accounts | all | all |
| Deposit | into own accounts | into any customer account | no |
| Withdraw | from own accounts | no | no |
| Transfer | out of own accounts, to any customer account | no | no |
| Create accounts, set an overdraft limit | no | yes | no |
| Refused-attempt log and reconciliation check | no | yes | yes |

Administrators cannot take customer money out. Every one of these rules is enforced on the server for
every request. The web page only hides what you cannot do.

## How the money stays right

- **Double-entry ledger.** Every movement is a transaction with two ledger entries, one debit and one
  credit. Deposits and withdrawals use a system account called EXTERNAL as the other side. So every
  transaction nets to zero, and the sum of all balances in the system is exactly 0. Customer money in total
  equals deposits minus withdrawals. `GET /audit/reconcile` recomputes this from the ledger.
- **Money is integer paise** (`BIGINT`), never a float.
- **One database transaction per request.** The accounts involved are locked with `SELECT ... FOR UPDATE`
  in ascending id order (so two opposite transfers cannot deadlock), the balance is read after the lock, the
  check and the debit happen under that same lock, and either everything commits or nothing does.
- **No overdraft unless authorised.** An account may go below zero only down to its `overdraft_limit`
  (default 0, set by an administrator). The server checks it, and a database `CHECK` constraint is the
  last line of defence.
- **Exactly once.** Every money request carries an `Idempotency-Key` header. The key row and the money
  movement commit in the same transaction. The same key with the same request returns the first answer and
  moves nothing. The same key with a different request is rejected. Two copies arriving at the same instant
  queue behind an advisory lock. `replay_count` in the database shows which requests were duplicates.
- **Append-only.** `ledger_entries`, `transactions` and `refused_attempts` have triggers that reject
  UPDATE, DELETE and TRUNCATE, and the application connects as `ledger_app`, a role that cannot do those
  things or switch the triggers off. Only the database owner can, and the owner password is not in the
  application's environment.
- **Refusals are recorded.** Insufficient funds and attempts on someone else's account are written to
  `refused_attempts`. Attempts on your own account show in your statement. Attempts on someone else's
  account are recorded against the person who made them and are visible to admin and auditor.

The full list of what I thought could go wrong, what I did about it, and the risks I knowingly left open is in
[THREATS.md](THREATS.md). How I used AI, and where it was wrong, is in [PROMPTS.md](PROMPTS.md).
Endpoint reference: [docs/API.md](docs/API.md).

## Run it locally (from a clean clone)

You need Node 20 or newer and PostgreSQL 15 or newer.

```bash
git clone https://github.com/Nishitha135/ledgerline.git
cd ledgerline
npm install
```

Create the database and the tables:

```bash
psql -U postgres -c "CREATE DATABASE ledgerline"
psql -U postgres -d ledgerline -f db/schema.sql
```

Copy `.env.example` to `.env` and set `DATABASE_URL` and `JWT_SECRET`
(`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` prints a good secret). If the
database password contains `@`, write it as `%40` in the URL. Then:

```bash
npm run seed     # three demo users, the EXTERNAL account and one holder account
npm start        # http://localhost:3000
```

## Run the tests

The tests use their own database and run the application as the least-privilege role, like production.

```bash
psql -U postgres -c "CREATE DATABASE ledgerline_test"
psql -U postgres -d ledgerline_test -f db/schema.sql
psql -U postgres -d ledgerline_test -v app_password=choose-a-password -f db/roles.sql
```

Set `TEST_DATABASE_URL` and `TEST_APP_DATABASE_URL` in `.env` (see `.env.example`), then `npm test`.

The tests fire real concurrent requests: 20 and 30 simultaneous withdrawals against a balance that covers
three, 10 identical requests with one key, opposite transfers at the same instant, and random mixed
traffic followed by a full conservation check against the database. They also cover authorisation (one
user cannot move another's money), the append-only ledger, the database role's privileges, and the proxy
setting. I checked that they bite: removing the row lock, the idempotency lock, the balance check or an
ownership check each makes tests fail (see THREATS.md).

## Deploy (what the live site uses)

1. **Database:** a Neon Postgres project. Run `db/schema.sql` as the owner. Run `npm run seed` once with
   `DATABASE_URL` set to the owner connection. Run `db/roles.sql` as the owner with
   `-v app_password=<long random password>` to create `ledger_app`.
2. **Web service:** Render, Node runtime, build command `npm install`, start command `npm start`, health
   check path `/health`.
3. **Environment variables on Render:** `DATABASE_URL` is the **`ledger_app`** connection (not the owner),
   and `JWT_SECRET` is a random string of at least 32 characters.
4. `src/app.js` sets `trust proxy` to 3, the number of proxies in front of the app on Render, measured from
   a real `X-Forwarded-For` header. Re-measure it if the app moves to another host.

## What I did not build

Multiple currencies, scheduled or batch transfers, reversals and refunds, and holds. There is no AI inside
the product and nothing that moves money on its own. A small system whose balances are always right
seemed better than a large one that is not sure. Known gaps are listed in THREATS.md.

## Attack it yourself

`npm run attack` fires the kinds of attacks a reviewer would, over HTTP, at a running server: 20
simultaneous withdrawals against a balance that covers three, 10 identical requests with one key, one user
touching another user's money, the auditor and the admin trying to move money, bad amounts and bad tokens,
and finally the reconcile check. Locally: start the server with `npm start`, then run `npm run attack`.
Against another host: set `BASE=https://your-host` first. It registers fresh users and leaves permanent
ledger rows, because the ledger is append-only.
