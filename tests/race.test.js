const { pool } = require('../src/db');
const h = require('./helpers');

// Open every pooled connection up front. On a cold pool, requests queue behind
// connection start-up and accidentally run one after another, which hides races.
async function warmPool(n = 10) {
  await Promise.all(Array.from({ length: n }, () => pool.query('SELECT pg_sleep(0.05)')));
}

beforeAll(async () => {
  await h.ensureSystemAccount();
  await warmPool();
});
afterAll(() => pool.end());

test('repeated races: 30 concurrent withdrawals, five rounds, never past the balance', async () => {
  const u = await h.makeUser('holder');
  const api = h.api(u);
  for (let round = 0; round < 5; round++) {
    const acct = await h.makeAccount(u.id);
    expect((await api.deposit(acct, 10000)).status).toBe(201);

    const results = await Promise.all(Array.from({ length: 30 }, () => api.withdraw(acct, 3000)));

    // 422 (refused by the application check), not 500 (stopped only by the DB constraint).
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(27);
    expect(await h.balanceOf(acct)).toBe(1000n);
    await h.assertLedgerConsistent([acct]);
  }
});

test('repeated races: 10 identical requests with one key, five rounds', async () => {
  const u = await h.makeUser('holder');
  const api = h.api(u);
  for (let round = 0; round < 5; round++) {
    const acct = await h.makeAccount(u.id);
    const key = h.newKey('race');

    const results = await Promise.all(Array.from({ length: 10 }, () => api.deposit(acct, 2500, key)));

    for (const r of results) expect(r.status).toBe(201);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await h.balanceOf(acct)).toBe(2500n);
  }
});
