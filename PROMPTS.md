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

**What I did:** Refusals for an account the caller does not own are now recorded against the attacker (account\_id empty, the target named in the reason) and are read by admin and auditor at GET /audit/refused. Added a test that the victim's statement stays clean and that a holder cannot read the audit endpoint.

**Commit:** https://github.com/Nishitha135/ledgerline/commit/2f356ad

## 2026-11-07: Rate limiter blind to the real client behind the host's proxies (abuse protection)

**Asked:** Add rate limiting to login and register so passwords cannot be guessed.

**Produced:** express-rate-limit with a per-IP window on the auth routes, with default settings.

**What was wrong:** On Render the app sits behind proxies and Express was not told to trust them. Every request would look like it came from one proxy address, so one noisy client could lock everybody out, and the real client address was never used. The generated code said nothing about this, and my local tests could not show it because they talk to the app directly. After deploying, Claude raised it as a suspicion and I checked: the live Render logs showed ERR\_ERL\_UNEXPECTED\_X\_FORWARDED\_FOR.

**What I did:** I did not guess the number of hops (too low shares one bucket, too high lets a client forge its own address). I added a temporary endpoint that echoed X-Forwarded-For, read three addresses from a live request (internal proxy, Cloudflare, my own IP) and set trust proxy to 3. I checked on the live URL that a forged X-Forwarded-For header is ignored, pinned the behaviour with proxy.test.js (mutation: remove the setting and it fails), and removed the debug endpoint.

**Commit:** https://github.com/Nishitha135/ledgerline/commit/85baba2

## 2026-11-07: Refusals by roles that may not move money left no record (audit trail)

**Asked:** Build the money endpoints with role checks, and record every refused attempt.

**Produced:** requireRole(...) as route middleware. It answers 403 immediately, before any refusal is recorded.

**What was wrong:** The spec says every refused attempt must be on the record. An auditor, or an admin trying to withdraw, got a 403 and left no trace, because the role gate ran before the code that writes refused\_attempts. Claude flagged this as a suspected gap when we listed what was still missing; I did not spot it myself. I did not take the suspicion on trust.

**What I did:** Wrote rolegate.test.js first (auditor and admin make four refused attempts, expect four rows and unchanged balances), stashed the fix and ran it against the old code to confirm it fails (1 failed), then replaced requireRole on the three money routes with a roleGate that writes the refusal (no account, the role and target in the reason) and then answers 403. Holders pass every gate, so a holder cannot use it to add rows. With the fix all 30 tests pass.

**Commit:** https://github.com/Nishitha135/ledgerline/commit/0f19e16

## 2026-11-07: Sign in failed silently when the server was unreachable (error handling)

**Asked:** Build a web UI for sign in, accounts, deposit, withdraw, transfer and the statement.

**Produced:** A UI whose money forms handled a network failure (with a retry using the same key), but whose sign in and register code did not. A failed fetch threw an exception that nothing caught.

**What was wrong:** With the server stopped, clicking Sign in did nothing: no message, no error on the page. A screenshot of the sign-in page with no error text made Claude suspect this; I reproduced it by stopping the local server and clicking Sign in, and nothing happened.

**What I did:** Moved the network error handling into the shared api() helper so it returns a clear result (Cannot reach the server) for every caller, and made the money path treat it as an unknown outcome, so it still offers a retry with the same Idempotency-Key. I checked by hand with the server stopped: sign in shows the message, and deposit shows that it may or may not have been processed. There is no automated browser test for this.

**Commit:** https://github.com/Nishitha135/ledgerline/commit/9f19299

## 2026-11-09: Sign-out left the previous user's data on the page (access control, UI)

**Asked:** Build a web UI with sign in, sign out and per-role views.

**Produced:** A single-page UI whose sign-out cleared the token and the in-memory state but not the page. The page is not reloaded, so the previous user's last result box and statement stayed in it and showed up for whoever signed in next.

**What was wrong:** I took a screenshot of the auditor view for the README, and it still showed the holder's "Deposit done" box and "Send again with the same key" button. When I sent Claude both screenshots it noticed the same Idempotency-Key in both. On a shared browser a second user would see the first user's statement until they clicked something. The server never sent anything new (every API call is authorised separately), but a reviewer testing two accounts in one browser would fairly call it an access-control failure. The stale "send again" button also threw an error, because the saved request had been cleared.

**What I did:** Added resetView(), called on sign-out, which clears the result box, statement, accounts table, audit panels, account pickers and form fields. I added a source-level test; there is no automated browser test.

Manual verification: On the live application, signed in as a holder and opened the statement. Signed out and signed in as an auditor. Verified that the previous holder's statement was cleared and the page displayed "Choose an account above." The auditor dashboard showed "Books balance: every check passes", with zero debit-credit differences and zero account-ledger mismatches. Signed out and signed in as admin; the account creation form was displayed. The form fields still need explicit empty-field verification.

**Commit:** https://github.com/Nishitha135/ledgerline/commit/cf401d4

