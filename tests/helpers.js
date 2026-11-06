const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/db');
const { jwtSecret } = require('../src/config');

let counter = 0;
const uniq = () => `${Date.now()}-${process.pid}-${counter++}`;
const newKey = (prefix = 'k') => `${prefix}-${uniq()}`;

async function ensureSystemAccount() {
  await pool.query(
    `INSERT INTO accounts (name, is_system)
     SELECT 'EXTERNAL', true WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE is_system)`
  );
}

// Users are inserted directly and given a signed token, so tests do not hit the login rate limit.
async function makeUser(role) {
  const { rows } = await pool.query(
    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [`${role}-${uniq()}@test.local`, 'x', role]
  );
  const id = String(rows[0].id);
  const token = jwt.sign({ sub: id }, jwtSecret, { algorithm: 'HS256', expiresIn: '1h' });
  return { id, token };
}

async function makeAccount(ownerId, overdraftLimit = 0) {
  const { rows } = await pool.query(
    'INSERT INTO accounts (owner_id, name, overdraft_limit) VALUES ($1, $2, $3) RETURNING id',
    [ownerId, `test-${uniq()}`, overdraftLimit]
  );
  return String(rows[0].id);
}

async function balanceOf(accountId) {
  const { rows } = await pool.query('SELECT balance FROM accounts WHERE id = $1', [accountId]);
  return BigInt(rows[0].balance);
}

function api(user) {
  const auth = { Authorization: `Bearer ${user.token}` };
  return {
    deposit: (accountId, amount, key = newKey('dep')) =>
      request(app).post(`/accounts/${accountId}/deposit`).set(auth).set('Idempotency-Key', key).send({ amount }),
    withdraw: (accountId, amount, key = newKey('wd')) =>
      request(app).post(`/accounts/${accountId}/withdraw`).set(auth).set('Idempotency-Key', key).send({ amount }),
    transfer: (fromAccountId, toAccountId, amount, key = newKey('trf')) =>
      request(app).post('/transfers').set(auth).set('Idempotency-Key', key)
        .send({ fromAccountId, toAccountId, amount }),
    account: (accountId) => request(app).get(`/accounts/${accountId}`).set(auth),
    statement: (accountId) => request(app).get(`/accounts/${accountId}/statement`).set(auth),
    raw: (method, path) => request(app)[method](path).set(auth),
  };
}

// The conservation proof, checked straight from the database.
async function assertLedgerConsistent(accountIds) {
  // 1. Every transaction nets to zero (credits = debits).
  const { rows: unbalanced } = await pool.query(
    `SELECT txn_id FROM ledger_entries GROUP BY txn_id
     HAVING SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END) <> 0`
  );
  expect(unbalanced).toEqual([]);

  // 2. All balances in the system sum to exactly zero.
  const { rows: [g] } = await pool.query('SELECT COALESCE(SUM(balance), 0) AS total FROM accounts');
  expect(BigInt(g.total)).toBe(0n);

  // 3. Each account's balance equals its ledger total and its last running balance.
  for (const id of accountIds) {
    const { rows: [a] } = await pool.query('SELECT balance FROM accounts WHERE id = $1', [id]);
    const { rows: [s] } = await pool.query(
      `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END), 0) AS net
       FROM ledger_entries WHERE account_id = $1`, [id]);
    expect(BigInt(s.net)).toBe(BigInt(a.balance));
    const { rows: last } = await pool.query(
      'SELECT balance_after FROM ledger_entries WHERE account_id = $1 ORDER BY id DESC LIMIT 1', [id]);
    if (last[0]) expect(BigInt(last[0].balance_after)).toBe(BigInt(a.balance));
  }
}

module.exports = { ensureSystemAccount, makeUser, makeAccount, balanceOf, api, newKey, assertLedgerConsistent };
