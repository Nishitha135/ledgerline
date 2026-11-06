const { pool } = require('../src/db');
const h = require('./helpers');

beforeAll(async () => {
  await h.ensureSystemAccount();
  await Promise.all(Array.from({ length: 10 }, () => pool.query('SELECT pg_sleep(0.05)')));
});
afterAll(() => pool.end());

describe('no overdraw under concurrency', () => {
  test('20 concurrent withdrawals of 3000 from a balance of 10000: exactly 3 succeed', async () => {
    const u = await h.makeUser('holder');
    const acct = await h.makeAccount(u.id);
    const api = h.api(u);
    expect((await api.deposit(acct, 10000)).status).toBe(201);

    const results = await Promise.all(Array.from({ length: 20 }, () => api.withdraw(acct, 3000)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(17); // refused, never a 500
    expect(await h.balanceOf(acct)).toBe(1000n);
    await h.assertLedgerConsistent([acct]);
  });

  test('an authorised overdraft limit is enforced under concurrency', async () => {
    const u = await h.makeUser('holder');
    const acct = await h.makeAccount(u.id, 5000); // may go to -5000, no further
    const api = h.api(u);

    const results = await Promise.all(Array.from({ length: 10 }, () => api.withdraw(acct, 1000)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 422)).toHaveLength(5);
    expect(await h.balanceOf(acct)).toBe(-5000n);
    await h.assertLedgerConsistent([acct]);
  });

  test('opposite transfers at the same instant do not deadlock and conserve money', async () => {
    const u = await h.makeUser('holder');
    const a = await h.makeAccount(u.id);
    const b = await h.makeAccount(u.id);
    const api = h.api(u);
    await api.deposit(a, 100000);
    await api.deposit(b, 100000);

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 ? api.transfer(a, b, 10) : api.transfer(b, a, 10)))
    );

    for (const r of results) expect(r.status).toBe(201); // a deadlock would surface as a 500
    expect((await h.balanceOf(a)) + (await h.balanceOf(b))).toBe(200000n);
    await h.assertLedgerConsistent([a, b]);
  });
});

describe('exactly once (idempotency)', () => {
  test('10 identical requests fired at once with one key move money once', async () => {
    const u = await h.makeUser('holder');
    const acct = await h.makeAccount(u.id);
    const api = h.api(u);
    const key = h.newKey('same');

    const results = await Promise.all(Array.from({ length: 10 }, () => api.deposit(acct, 5000, key)));

    for (const r of results) expect(r.status).toBe(201);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    expect(await h.balanceOf(acct)).toBe(5000n);

    const { rows: [e] } = await pool.query('SELECT count(*)::int AS n FROM ledger_entries WHERE account_id = $1', [acct]);
    expect(e.n).toBe(1);
    const { rows: [k] } = await pool.query(
      'SELECT replay_count FROM idempotency_keys WHERE user_id = $1 AND key = $2', [u.id, key]);
    expect(k.replay_count).toBe(9); // the duplicates are provable in the data
  });

  test('a replayed transfer pays only once and returns the first answer', async () => {
    const u = await h.makeUser('holder');
    const from = await h.makeAccount(u.id);
    const to = await h.makeAccount((await h.makeUser('holder')).id);
    const api = h.api(u);
    await api.deposit(from, 10000);
    const key = h.newKey('pay');

    const first = await api.transfer(from, to, 4000, key);
    const second = await api.transfer(from, to, 4000, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.transactionId).toBe(first.body.transactionId);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await h.balanceOf(from)).toBe(6000n);
    expect(await h.balanceOf(to)).toBe(4000n);
  });

  test('the same key with a different request is rejected and moves nothing', async () => {
    const u = await h.makeUser('holder');
    const acct = await h.makeAccount(u.id);
    const api = h.api(u);
    const key = h.newKey('reuse');
    expect((await api.deposit(acct, 100, key)).status).toBe(201);

    const second = await api.deposit(acct, 999, key);

    expect(second.status).toBe(422);
    expect(await h.balanceOf(acct)).toBe(100n);
  });

  test('a refused request replayed is logged once', async () => {
    const u = await h.makeUser('holder');
    const acct = await h.makeAccount(u.id);
    const api = h.api(u);
    const key = h.newKey('ovr');

    const r1 = await api.withdraw(acct, 999999, key);
    const r2 = await api.withdraw(acct, 999999, key);

    expect(r1.status).toBe(422);
    expect(r2.status).toBe(422);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    const { rows: [c] } = await pool.query(
      'SELECT count(*)::int AS n FROM refused_attempts WHERE idempotency_key = $1', [key]);
    expect(c.n).toBe(1);
  });
});

describe('conservation', () => {
  test('random concurrent transfers, deposits and withdrawals: total changes only by external flows', async () => {
    const u = await h.makeUser('holder');
    const api = h.api(u);
    const accts = [];
    for (let i = 0; i < 5; i++) accts.push(await h.makeAccount(u.id));
    for (const a of accts) expect((await api.deposit(a, 10000)).status).toBe(201);

    const pick = () => accts[Math.floor(Math.random() * accts.length)];
    const ops = [];
    for (let i = 0; i < 60; i++) {
      const from = pick();
      let to = pick();
      while (to === from) to = pick();
      const amount = 1 + Math.floor(Math.random() * 6000);
      ops.push({ kind: 'transfer', amount, run: () => api.transfer(from, to, amount) });
    }
    for (let i = 0; i < 10; i++) {
      const acct = pick();
      ops.push({ kind: 'deposit', amount: 700, run: () => api.deposit(acct, 700) });
      ops.push({ kind: 'withdrawal', amount: 500, run: () => api.withdraw(acct, 500) });
    }

    const results = await Promise.all(ops.map((o) => o.run()));

    let expected = 50000n;
    results.forEach((r, i) => {
      expect([201, 422]).toContain(r.status); // never a 500
      if (r.status === 201 && ops[i].kind === 'deposit') expected += BigInt(ops[i].amount);
      if (r.status === 201 && ops[i].kind === 'withdrawal') expected -= BigInt(ops[i].amount);
    });

    let total = 0n;
    for (const a of accts) {
      const bal = await h.balanceOf(a);
      expect(bal).toBeGreaterThanOrEqual(0n);
      total += bal;
    }
    expect(total).toBe(expected);
    await h.assertLedgerConsistent(accts);
  });
});

describe('authorisation', () => {
  test('one user cannot move another user\'s money', async () => {
    const alice = await h.makeUser('holder');
    const bob = await h.makeUser('holder');
    const aliceAcct = await h.makeAccount(alice.id);
    const bobAcct = await h.makeAccount(bob.id);
    await h.api(alice).deposit(aliceAcct, 10000);
    const bobApi = h.api(bob);

    expect((await bobApi.withdraw(aliceAcct, 100)).status).toBe(403);
    expect((await bobApi.transfer(aliceAcct, bobAcct, 100)).status).toBe(403);
    expect((await bobApi.deposit(aliceAcct, 100)).status).toBe(403);

    expect(await h.balanceOf(aliceAcct)).toBe(10000n);
    expect(await h.balanceOf(bobAcct)).toBe(0n);

    const { rows: [r] } = await pool.query(
      'SELECT count(*)::int AS n FROM refused_attempts WHERE user_id = $1 AND account_id IS NULL AND reason LIKE $2', [bob.id, `%account ${aliceAcct}%`]);
    expect(r.n).toBe(3); // every refused attempt is on the record
  });

  test('roles: auditor is read-only, admin cannot take customer money', async () => {
    const alice = await h.makeUser('holder');
    const auditor = await h.makeUser('auditor');
    const admin = await h.makeUser('admin');
    const acct = await h.makeAccount(alice.id);
    await h.api(alice).deposit(acct, 10000);

    expect((await h.api(auditor).deposit(acct, 100)).status).toBe(403);
    expect((await h.api(auditor).withdraw(acct, 100)).status).toBe(403);
    expect((await h.api(admin).withdraw(acct, 100)).status).toBe(403);
    expect((await h.api(admin).transfer(acct, acct, 100)).status).toBe(403);
    expect((await h.api(admin).deposit(acct, 500)).status).toBe(201);
    expect(await h.balanceOf(acct)).toBe(10500n);

    expect((await h.api(auditor).account(acct)).status).toBe(200);
    expect((await h.api(auditor).statement(acct)).status).toBe(200);
  });

  test('a holder cannot read another holder\'s account or statement', async () => {
    const alice = await h.makeUser('holder');
    const bob = await h.makeUser('holder');
    const acct = await h.makeAccount(alice.id);
    expect((await h.api(bob).account(acct)).status).toBe(404);
    expect((await h.api(bob).statement(acct)).status).toBe(404);
  });

  test('no token or a garbage token is rejected', async () => {
    const request = require('supertest');
    const app = require('../src/app');
    expect((await request(app).get('/accounts')).status).toBe(401);
    expect((await request(app).get('/accounts').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });
});

describe('input validation', () => {
  test('bad amounts, bad ids and missing keys are rejected before any money moves', async () => {
    const u = await h.makeUser('holder');
    const acct = await h.makeAccount(u.id);
    const api = h.api(u);

    for (const amount of [0, -5, 1.5, '100', null, 10 ** 13]) {
      expect((await api.deposit(acct, amount)).status).toBe(400);
    }
    const request = require('supertest');
    const app = require('../src/app');
    const noKey = await request(app).post(`/accounts/${acct}/deposit`)
      .set('Authorization', `Bearer ${u.token}`).send({ amount: 100 });
    expect(noKey.status).toBe(400);
    expect((await api.deposit(acct, 100, 'short')).status).toBe(400);
    expect((await api.transfer(acct, acct, 100)).status).toBe(400);
    expect((await api.deposit('999999999', 100)).status).toBe(404);
    expect(await h.balanceOf(acct)).toBe(0n);
  });
});

describe('the ledger is append-only', () => {
  test('UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
    const u = await h.makeUser('holder');
    const acct = await h.makeAccount(u.id);
    await h.api(u).deposit(acct, 1000);
    await h.api(u).withdraw(acct, 999999); // creates a refused attempt too

    await expect(pool.query('UPDATE ledger_entries SET amount = amount + 1')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE ledger_entries')).rejects.toThrow(/append-only/);
    await expect(pool.query('UPDATE transactions SET type = type')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM transactions')).rejects.toThrow(/append-only/);
    await expect(pool.query('UPDATE refused_attempts SET reason = reason')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM refused_attempts')).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE refused_attempts')).rejects.toThrow(/append-only/);

    expect(await h.balanceOf(acct)).toBe(1000n);
  });
});
