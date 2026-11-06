# PROMPTS.md

AI tool used: Claude (chat). Each entry has what I asked, what it produced, what was wrong,
what I did instead, and the commit.

## 2026-11-06: A concurrency test that passed without the lock (money integrity)

**Asked:** Write automated tests proving that two concurrent withdrawals cannot overdraw an account.

**Produced:** A test that fires 20 parallel withdrawals of 3000 at a balance of 10000 and expects exactly 3 successes.

**What was wrong:** As a check I deleted the row lock (FOR UPDATE) from the ledger code and re-ran the suite. The headline test still passed. The connection pool was cold, so the requests queued behind connection start-up and ran one after another, and the race never happened. The test looked like a concurrency test but did not test concurrency.

**What I did:** Warmed the pool before the tests, added race.test.js (30 concurrent withdrawals, repeated for five rounds, asserting 422 from the application check rather than 500 from the database constraint). I re-ran the mutation: now four tests fail, including the headline one.

**Commit:** https://github.com/Nishitha135/ledgerline/commit/2c24a0b

## 2026-11-06: Refused 403 attempts were written onto the victim's statement (audit integrity)

**Asked:** Build the ledger service so every refused attempt is recorded and shown in the account statement.

**Produced:** A refuse() helper that stored a refused attempt against the target account, including for 403 (a user trying to move another user's money).

**What was wrong:** Any registered user could write refused rows, with their own email, onto another user's statement. The table is append-only, so those rows can never be removed. That is both a flooding vector and an information leak. The generated code did not flag it. It came up while writing THREATS.md.

**What I did:** Refusals for an account the caller does not own are now recorded against the attacker (account_id empty, the target named in the reason) and are read by admin and auditor at GET /audit/refused. Added a test that the victim's statement stays clean and that a holder cannot read the audit endpoint.

**Commit:** https://github.com/Nishitha135/ledgerline/commit/2f356ad
