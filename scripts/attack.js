'use strict';
// Attacks a running LedgerLine from the outside, over HTTP only, the way a judge would.
//   Local:  node scripts/attack.js            (the server must be running on :3000)
//   Live:   $env:BASE='https://ledgerline-5vah.onrender.com'; node scripts/attack.js
// It registers fresh users, so the demo accounts are not touched, and funds them through the admin.
// On a live ledger the rows it creates are permanent, because the ledger is append-only.

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
let failures = 0;

async function call(method, path, { token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data, replayed: res.headers.get('idempotent-replayed') === 'true' };
}

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

const uid = () => Math.random().toString(36).slice(2, 10);

async function login(email, password) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (!r.data || !r.data.token) throw new Error(`login failed for ${email} (HTTP ${r.status})`);
  return r.data.token;
}

async function main() {
  console.log(`Attacking ${BASE}\n`);
  await call('GET', '/health'); // wakes a sleeping free-tier host

  const admin = await login('admin@ledgerline.test', 'AdminDemo#2026');
  const auditor = await login('auditor@ledgerline.test', 'AuditorDemo#2026');

  async function newHolder(label) {
    const email = `${label}-${uid()}@attack.test`;
    const password = `Attack-${uid()}-pw`;
    const reg = await call('POST', '/auth/register', { body: { email, password } });
    if (reg.status !== 201) throw new Error(`register failed (HTTP ${reg.status})`);
    const token = await login(email, password);
    const acc = await call('POST', '/accounts', {
      token: admin, body: { ownerEmail: email, name: `${label} account`, overdraftLimit: 0 },
    });
    if (acc.status !== 201) throw new Error(`create account failed (HTTP ${acc.status})`);
    return { token, id: String(acc.data.id) };
  }

  const balance = async (acct, token) =>
    BigInt((await call('GET', `/accounts/${acct.id}`, { token })).data.balance);
  const withdraw = (acct, amount, key) =>
    call('POST', `/accounts/${acct.id}/withdraw`, { token: acct.token, key: key || `wd-${uid()}`, body: { amount } });
  const deposit = (acct, amount, key) =>
    call('POST', `/accounts/${acct.id}/deposit`, { token: acct.token, key: key || `dp-${uid()}`, body: { amount } });

  const alice = await newHolder('alice');
  const bob = await newHolder('bob');
  const fund = await call('POST', `/accounts/${alice.id}/deposit`, {
    token: admin, key: `fund-${uid()}`, body: { amount: 10000 },
  });
  check('setup: admin funds Alice with 100.00', fund.status === 201, `HTTP ${fund.status}`);

  console.log('\n--- Two requests at the same instant ---');
  const race = await Promise.all(Array.from({ length: 20 }, () => withdraw(alice, 3000)));
  const won = race.filter((r) => r.status === 201).length;
  const refused = race.filter((r) => r.status === 422).length;
  check('20 simultaneous withdrawals of 30.00 from 100.00: exactly 3 succeed', won === 3, `${won} succeeded`);
  check('the other 17 are refused cleanly (422), none crash', refused === 17, `${refused} refused`);
  const afterRace = await balance(alice, alice.token);
  check('balance is exactly 10.00 and never negative', afterRace === 1000n, `paise ${afterRace}`);

  console.log('\n--- The same request arriving many times ---');
  const key = `same-${uid()}`;
  const dups = await Promise.all(Array.from({ length: 10 }, () => deposit(alice, 5000, key)));
  check('10 identical requests with one key all get 201', dups.every((r) => r.status === 201));
  check('they all share ONE transaction id',
    new Set(dups.map((r) => r.data && r.data.transactionId)).size === 1);
  check('9 of them are marked as replays', dups.filter((r) => r.replayed).length === 9);
  check('money moved once: balance is 60.00', (await balance(alice, alice.token)) === 6000n);
  const clash = await deposit(alice, 999, key);
  check('the same key with a different amount is rejected (422)', clash.status === 422, `HTTP ${clash.status}`);

  console.log("\n--- Someone else's money ---");
  const t1 = await call('POST', `/accounts/${alice.id}/withdraw`, { token: bob.token, key: `s-${uid()}`, body: { amount: 100 } });
  check("Bob cannot withdraw from Alice's account (403)", t1.status === 403, `HTTP ${t1.status}`);
  const t2 = await call('POST', '/transfers', {
    token: bob.token, key: `s-${uid()}`, body: { fromAccountId: alice.id, toAccountId: bob.id, amount: 100 },
  });
  check("Bob cannot transfer out of Alice's account (403)", t2.status === 403, `HTTP ${t2.status}`);
  const t3 = await call('POST', `/accounts/${alice.id}/deposit`, { token: bob.token, key: `s-${uid()}`, body: { amount: 100 } });
  check("Bob cannot deposit into Alice's account (403)", t3.status === 403, `HTTP ${t3.status}`);
  const t4 = await call('GET', `/accounts/${alice.id}`, { token: bob.token });
  check("Bob cannot even read Alice's account (404)", t4.status === 404, `HTTP ${t4.status}`);
  const t5 = await call('POST', `/accounts/${alice.id}/deposit`, { token: auditor, key: `s-${uid()}`, body: { amount: 100 } });
  check('the auditor cannot move money (403)', t5.status === 403, `HTTP ${t5.status}`);
  const t6 = await call('POST', `/accounts/${alice.id}/withdraw`, { token: admin, key: `s-${uid()}`, body: { amount: 100 } });
  check("the admin cannot take a customer's money (403)", t6.status === 403, `HTTP ${t6.status}`);
  const t7 = await withdraw(bob, 1);
  check('Bob cannot overdraw his own empty account (422)', t7.status === 422, `HTTP ${t7.status}`);
  check("after all that, Alice still has exactly 60.00", (await balance(alice, alice.token)) === 6000n);
  check('and Bob still has exactly 0.00', (await balance(bob, bob.token)) === 0n);

  console.log('\n--- Bad requests and bad tokens ---');
  const forged = `${alice.token.slice(0, -2)}xx`;
  check('a tampered token is rejected (401)', (await call('GET', '/accounts', { token: forged })).status === 401);
  check('no token is rejected (401)', (await call('GET', '/accounts')).status === 401);
  check('a negative amount is rejected (400)', (await deposit(alice, -5)).status === 400);
  check('a fractional amount is rejected (400)', (await deposit(alice, 1.5)).status === 400);
  check('an amount sent as a string is rejected (400)', (await deposit(alice, '100')).status === 400);
  const noKey = await call('POST', `/accounts/${alice.id}/deposit`, { token: alice.token, body: { amount: 100 } });
  check('a missing Idempotency-Key is rejected (400)', noKey.status === 400, `HTTP ${noKey.status}`);

  console.log('\n--- Do the books balance? ---');
  const rec = await call('GET', '/audit/reconcile', { token: auditor });
  check('reconcile: every check passes', rec.data && rec.data.ok === true);
  check('reconcile: all balances add up to exactly 0', rec.data && rec.data.totalBalance === '0');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`Could not finish: ${err.message}`); process.exit(2); });
