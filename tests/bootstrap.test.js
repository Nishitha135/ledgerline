const { pool } = require('../src/db');
const h = require('./helpers');
const { bootstrapAdmin } = require('../scripts/bootstrap-admin');

afterAll(() => pool.end());

test('bootstrap refuses a bad email or a short password before touching the database', async () => {
  await expect(bootstrapAdmin(pool, { email: 'not-an-email', password: 'a-long-enough-password' })).rejects.toThrow(/valid email/);
  await expect(bootstrapAdmin(pool, { email: 'boss@test.local', password: 'short' })).rejects.toThrow(/at least 12/);
  await expect(bootstrapAdmin(pool, { email: 'boss@test.local' })).rejects.toThrow(/at least 12/);
});

test('bootstrap refuses once an administrator exists and creates nothing', async () => {
  await h.makeUser('admin');
  const email = `late-${Date.now()}@test.local`;
  const r = await bootstrapAdmin(pool, { email, password: 'a-long-enough-password' });
  expect(r.created).toBe(false);
  const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  expect(rows).toHaveLength(0);
});
