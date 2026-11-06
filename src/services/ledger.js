const { withTx } = require('../db');

const cmp = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const isOwner = (user, acct) => user.role === 'holder' && String(acct.owner_id) === String(user.id);

// Plain read (no lock): owner_id and is_system never change.
async function getAccount(client, id) {
  const { rows } = await client.query(
    'SELECT id, owner_id, is_system FROM accounts WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getSystemId(client) {
  const { rows } = await client.query('SELECT id FROM accounts WHERE is_system');
  return String(rows[0].id);
}

// ALWAYS lock in ascending id order, so two opposite transfers cannot deadlock.
// Balances are read AFTER the lock is held.
async function lockAccounts(client, ids) {
  const sorted = [...new Set(ids.map(String))].sort(cmp);
  const locked = new Map();
  for (const id of sorted) {
    const { rows } = await client.query(
      'SELECT id, balance, overdraft_limit FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    locked.set(id, rows[0]);
  }
  return locked;
}

// Records a refused attempt and returns the response for it. No money moves.
async function refuse(client, ctx, accountId, status, reason) {
  await client.query(
    `INSERT INTO refused_attempts (user_id, account_id, type, amount, reason, idempotency_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
    [ctx.user.id, accountId, ctx.type, ctx.amount, reason, ctx.key]
  );
  return { status, body: { error: reason, refused: true } };
}

// Writes the transaction, updates balances and appends one ledger row per leg.
// Caller must already hold the locks.
async function post(client, ctx, legs) {
  const { rows: [txn] } = await client.query(
    `INSERT INTO transactions (type, initiated_by, created_at)
     VALUES ($1, $2, clock_timestamp()) RETURNING id`,
    [ctx.type, ctx.user.id]
  );
  const balances = {};
  for (const leg of [...legs].sort((a, b) => cmp(a.accountId, b.accountId))) {
    const delta = leg.direction === 'credit' ? ctx.amount : `-${ctx.amount}`;
    const { rows: [acct] } = await client.query(
      'UPDATE accounts SET balance = balance + $1::bigint WHERE id = $2 RETURNING balance',
      [delta, leg.accountId]
    );
    await client.query(
      `INSERT INTO ledger_entries (txn_id, account_id, direction, amount, balance_after, created_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
      [txn.id, leg.accountId, leg.direction, ctx.amount, acct.balance]
    );
    balances[leg.accountId] = acct.balance;
  }
  return { txnId: txn.id, balances };
}

function depositWork(ctx, accountId) {
  return async (client) => {
    const acct = await getAccount(client, accountId);
    if (!acct || acct.is_system) return refuse(client, ctx, null, 404, 'account not found');
    const entitled = ctx.user.role === 'admin' || isOwner(ctx.user, acct);
    if (!entitled) return refuse(client, ctx, accountId, 403, 'not entitled to deposit into this account');

    const systemId = await getSystemId(client);
    await lockAccounts(client, [accountId, systemId]);
    const { txnId, balances } = await post(client, ctx, [
      { accountId: systemId, direction: 'debit' },
      { accountId, direction: 'credit' },
    ]);
    return {
      status: 201, txnId,
      body: { transactionId: String(txnId), type: 'deposit', amount: ctx.amount, balance: balances[accountId] },
    };
  };
}

function withdrawWork(ctx, accountId) {
  return async (client) => {
    const acct = await getAccount(client, accountId);
    if (!acct || acct.is_system) return refuse(client, ctx, null, 404, 'account not found');
    if (!isOwner(ctx.user, acct)) return refuse(client, ctx, accountId, 403, 'not entitled to withdraw from this account');

    const systemId = await getSystemId(client);
    const locked = await lockAccounts(client, [accountId, systemId]);
    const a = locked.get(String(accountId));
    if (BigInt(a.balance) - BigInt(ctx.amount) < -BigInt(a.overdraft_limit)) {
      return refuse(client, ctx, accountId, 422, 'insufficient funds');
    }
    const { txnId, balances } = await post(client, ctx, [
      { accountId, direction: 'debit' },
      { accountId: systemId, direction: 'credit' },
    ]);
    return {
      status: 201, txnId,
      body: { transactionId: String(txnId), type: 'withdrawal', amount: ctx.amount, balance: balances[accountId] },
    };
  };
}

function transferWork(ctx, fromId, toId) {
  return async (client) => {
    if (fromId === toId) return refuse(client, ctx, fromId, 400, 'cannot transfer to the same account');
    const src = await getAccount(client, fromId);
    if (!src || src.is_system) return refuse(client, ctx, null, 404, 'source account not found');
    if (!isOwner(ctx.user, src)) return refuse(client, ctx, fromId, 403, 'not entitled to move money from this account');
    const dst = await getAccount(client, toId);
    if (!dst || dst.is_system) return refuse(client, ctx, fromId, 404, 'destination account not found');

    const locked = await lockAccounts(client, [fromId, toId]);
    const a = locked.get(String(fromId));
    if (BigInt(a.balance) - BigInt(ctx.amount) < -BigInt(a.overdraft_limit)) {
      return refuse(client, ctx, fromId, 422, 'insufficient funds');
    }
    const { txnId, balances } = await post(client, ctx, [
      { accountId: fromId, direction: 'debit' },
      { accountId: toId, direction: 'credit' },
    ]);
    return {
      status: 201, txnId,
      body: {
        transactionId: String(txnId), type: 'transfer', amount: ctx.amount,
        from: fromId, to: toId, balance: balances[fromId],
      },
    };
  };
}

// Exactly-once wrapper. Key row and money movement commit in ONE transaction,
// so "key exists" always means "this request was fully processed".
async function runIdempotent({ user, key, requestHash }, work) {
  return withTx(async (client) => {
    // Two requests with the same key queue here; the second sees the first's committed row.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${user.id}:${key}`]);

    const { rows } = await client.query(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [user.id, key]
    );
    if (rows[0]) {
      if (rows[0].request_hash !== requestHash) {
        return { status: 422, body: { error: 'idempotency key was already used for a different request' }, replayed: false };
      }
      await client.query(
        'UPDATE idempotency_keys SET replay_count = replay_count + 1 WHERE user_id = $1 AND key = $2',
        [user.id, key]
      );
      return { status: rows[0].response_status, body: rows[0].response_body, replayed: true };
    }

    const result = await work(client);
    await client.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, response_status, response_body, txn_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, key, requestHash, result.status, JSON.stringify(result.body), result.txnId || null]
    );
    return { ...result, replayed: false };
  });
}

module.exports = { runIdempotent, depositWork, withdrawWork, transferWork };
