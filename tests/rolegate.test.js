const { pool } = require('../src/db');
const h = require('./helpers');

beforeAll(() => h.ensureSystemAccount());
afterAll(() => pool.end());

test('a role that may not move money is refused and the refusal is on the record', async () => {
  const alice = await h.makeUser('holder');
  const auditor = await h.makeUser('auditor');
  const admin = await h.makeUser('admin');
  const acct = await h.makeAccount(alice.id);
  await h.api(alice).deposit(acct, 5000);

  expect((await h.api(auditor).deposit(acct, 100)).status).toBe(403);
  expect((await h.api(auditor).withdraw(acct, 100)).status).toBe(403);
  expect((await h.api(auditor).transfer(acct, acct, 100)).status).toBe(403);
  expect((await h.api(admin).withdraw(acct, 100)).status).toBe(403);

  const count = async (id) => {
    const { rows: [r] } = await pool.query('SELECT count(*)::int AS n FROM refused_attempts WHERE user_id = $1', [id]);
    return r.n;
  };
  expect(await count(auditor.id)).toBe(3);
  expect(await count(admin.id)).toBe(1);
  expect(await h.balanceOf(acct)).toBe(5000n);

  const seen = await h.api(auditor).raw('get', '/audit/refused?limit=1000');
  expect(seen.body.some((r) => r.reason.includes('role auditor may not move money (withdrawal)'))).toBe(true);
});
