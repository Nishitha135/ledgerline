const express = require('express');
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const staff = [authenticate, requireRole('admin', 'auditor')];

// Every refused attempt, including attempts on accounts the caller does not own.
router.get('/refused', ...staff, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.created_at, r.type, r.amount, r.reason, r.account_id,
              r.idempotency_key, u.email AS initiated_by
       FROM refused_attempts r
       JOIN users u ON u.id = r.user_id
       ORDER BY r.id DESC
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('audit refused failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// Recomputes the invariants from the ledger, in one consistent snapshot.
router.get('/reconcile', ...staff, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const unbalanced = await client.query(
      `SELECT txn_id FROM ledger_entries GROUP BY txn_id
       HAVING SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END) <> 0`
    );
    const total = await client.query('SELECT COALESCE(SUM(balance), 0) AS total FROM accounts');
    const mismatched = await client.query(
      `SELECT a.id, a.balance, COALESCE(s.net, 0) AS ledger_net
       FROM accounts a
       LEFT JOIN (
         SELECT account_id, SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END) AS net
         FROM ledger_entries GROUP BY account_id
       ) s ON s.account_id = a.id
       WHERE a.balance <> COALESCE(s.net, 0)`
    );
    const entries = await client.query('SELECT count(*)::int AS n FROM ledger_entries');
    const idem = await client.query(
      'SELECT count(*)::int AS keys, COALESCE(SUM(replay_count), 0)::int AS replays FROM idempotency_keys'
    );
    await client.query('COMMIT');

    const totalBalance = String(total.rows[0].total);
    res.json({
      ok: unbalanced.rows.length === 0 && mismatched.rows.length === 0 && totalBalance === '0',
      checkedAt: new Date().toISOString(),
      totalBalance, // must be 0: customer money is exactly offset by EXTERNAL
      ledgerEntries: entries.rows[0].n,
      unbalancedTransactions: unbalanced.rows.map((r) => String(r.txn_id)),
      mismatchedAccounts: mismatched.rows,
      idempotencyKeys: idem.rows[0].keys,
      duplicateRequestsBlocked: idem.rows[0].replays,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('reconcile failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  } finally {
    client.release();
  }
});

module.exports = router;
