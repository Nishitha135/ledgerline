const { Pool } = require('pg');
const { pool } = require('../src/db'); // connects as ledger_app (see tests/setup.js)
const h = require('./helpers');

const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

beforeAll(() => h.ensureSystemAccount());
afterAll(async () => {
  await owner.end();
  await pool.end();
});

test('the application connects as ledger_app, not as the database owner', async () => {
  const { rows: [r] } = await pool.query(
    "SELECT current_user AS name, current_setting('is_superuser') AS is_super"
  );
  expect(r.name).toBe('ledger_app');
  expect(r.is_super).toBe('off');
});

test('ledger_app cannot change history, even without the triggers', async () => {
  const statements = [
    'UPDATE ledger_entries SET amount = amount + 1',
    'DELETE FROM ledger_entries',
    'TRUNCATE ledger_entries',
    'UPDATE transactions SET type = type',
    'DELETE FROM transactions',
    'TRUNCATE transactions',
    'UPDATE refused_attempts SET reason = reason',
    'DELETE FROM refused_attempts',
    'TRUNCATE refused_attempts',
  ];
  for (const sql of statements) {
    await expect(pool.query(sql)).rejects.toThrow(/permission denied/);
  }
});

test('ledger_app cannot switch off the triggers or drop the tables', async () => {
  await expect(pool.query('ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only'))
    .rejects.toThrow(/must be owner|permission denied/);
  await expect(pool.query('DROP TRIGGER ledger_entries_append_only ON ledger_entries'))
    .rejects.toThrow(/must be owner|permission denied/);
  await expect(pool.query('DROP TABLE ledger_entries'))
    .rejects.toThrow(/must be owner|permission denied/);
  await expect(pool.query("SET session_replication_role = 'replica'"))
    .rejects.toThrow(/permission denied/);
});

test('ledger_app cannot reassign accounts or change roles', async () => {
  await expect(pool.query('UPDATE accounts SET owner_id = owner_id')).rejects.toThrow(/permission denied/);
  await expect(pool.query('UPDATE accounts SET overdraft_limit = 0')).rejects.toThrow(/permission denied/);
  await expect(pool.query('DELETE FROM accounts')).rejects.toThrow(/permission denied/);
  await expect(pool.query("UPDATE users SET role = 'admin'")).rejects.toThrow(/permission denied/);
  await expect(pool.query('DELETE FROM users')).rejects.toThrow(/permission denied/);
});

test('the triggers still stop the database owner (second layer)', async () => {
  const u = await h.makeUser('holder');
  const acct = await h.makeAccount(u.id);
  await h.api(u).deposit(acct, 1000); // makes sure there are rows for the row-level triggers
  await expect(owner.query('UPDATE ledger_entries SET amount = amount + 1')).rejects.toThrow(/append-only/);
  await expect(owner.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
  await expect(owner.query('TRUNCATE ledger_entries')).rejects.toThrow(/append-only/);
});
