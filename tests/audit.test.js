const { pool } = require('../src/db');
const h = require('./helpers');

beforeAll(() => h.ensureSystemAccount());
afterAll(() => pool.end());

test('an attack on someone else\'s account is not written into the victim\'s statement', async () => {
  const alice = await h.makeUser('holder');
  const bob = await h.makeUser('holder');
  const aliceAcct = await h.makeAccount(alice.id);
  await h.api(alice).deposit(aliceAcct, 5000);

  for (let i = 0; i < 3; i++) expect((await h.api(bob).withdraw(aliceAcct, 100)).status).toBe(403);

  const st = await h.api(alice).statement(aliceAcct);
  expect(st.status).toBe(200);
  expect(st.body.entries.filter((e) => e.kind === 'refused')).toHaveLength(0);
});

test('auditor and admin can see the attempt, a holder cannot', async () => {
  const alice = await h.makeUser('holder');
  const bob = await h.makeUser('holder');
  const auditor = await h.makeUser('auditor');
  const admin = await h.makeUser('admin');
  const aliceAcct = await h.makeAccount(alice.id);
  await h.api(bob).withdraw(aliceAcct, 100);

  for (const staff of [auditor, admin]) {
    const res = await h.api(staff).raw('get', '/audit/refused?limit=1000');
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.type === 'withdrawal' && r.reason.includes(`account ${aliceAcct}`))).toBe(true);
  }
  expect((await h.api(bob).raw('get', '/audit/refused')).status).toBe(403);
});

test('reconcile: invariants hold for the auditor, and a holder cannot call it', async () => {
  const alice = await h.makeUser('holder');
  const auditor = await h.makeUser('auditor');
  const a = await h.makeAccount(alice.id);
  const b = await h.makeAccount(alice.id);
  await h.api(alice).deposit(a, 7000);
  await h.api(alice).transfer(a, b, 2500);

  const res = await h.api(auditor).raw('get', '/audit/reconcile');
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.totalBalance).toBe('0');
  expect(res.body.unbalancedTransactions).toEqual([]);
  expect(res.body.mismatchedAccounts).toEqual([]);
  expect(res.body.ledgerEntries).toBeGreaterThan(0);

  expect((await h.api(alice).raw('get', '/audit/reconcile')).status).toBe(403);
});
