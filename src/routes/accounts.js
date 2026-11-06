const express = require('express');
const { z } = require('zod');
const { pool } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
const ID_RE = /^[1-9]\d{0,17}$/;

// Admin creates accounts for holders.
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const p = z.object({
    ownerEmail: z.string().email(),
    name: z.string().min(1).max(100),
    overdraftLimit: z.number().int().min(0).max(1_000_000_000_000).default(0),
  }).safeParse(req.body || {});
  if (!p.success) return res.status(400).json({ error: 'invalid input' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO accounts (owner_id, name, overdraft_limit)
       SELECT id, $2::text, $3::bigint FROM users WHERE email = $1 AND role = 'holder'
       RETURNING id, owner_id, name, balance, overdraft_limit`,
      [p.data.ownerEmail.toLowerCase(), p.data.name, p.data.overdraftLimit]
    );
    if (!rows[0]) return res.status(404).json({ error: 'no holder with that email' });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('create account failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// Holders see their own accounts; admin and auditor see all (including EXTERNAL).
router.get('/', authenticate, async (req, res) => {
  try {
    const base = 'SELECT id, owner_id, name, is_system, balance, overdraft_limit FROM accounts';
    const { rows } = req.user.role === 'holder'
      ? await pool.query(`${base} WHERE owner_id = $1 ORDER BY id`, [req.user.id])
      : await pool.query(`${base} ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error('list accounts failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// Returns the account if this user may view it; otherwise answers 404 (no existence leak).
async function loadViewable(req, res) {
  const notFound = () => { res.status(404).json({ error: 'account not found' }); return null; };
  if (!ID_RE.test(req.params.id)) return notFound();
  const { rows } = await pool.query(
    'SELECT id, owner_id, name, is_system, balance, overdraft_limit FROM accounts WHERE id = $1',
    [req.params.id]
  );
  const a = rows[0];
  if (!a) return notFound();
  const staff = req.user.role === 'admin' || req.user.role === 'auditor';
  const mine = !a.is_system && String(a.owner_id) === String(req.user.id);
  return staff || mine ? a : notFound();
}

router.get('/:id', authenticate, async (req, res) => {
  try {
    const a = await loadViewable(req, res);
    if (a) res.json(a);
  } catch (err) {
    console.error('get account failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// Every posting AND every refused attempt, newest first, with the running balance.
router.get('/:id/statement', authenticate, async (req, res) => {
  try {
    const a = await loadViewable(req, res);
    if (!a) return;
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT 'posted' AS kind, e.id, e.created_at, t.type, e.direction, e.amount,
                e.balance_after, u.email AS initiated_by, NULL::text AS reason, t.id AS txn_id
         FROM ledger_entries e
         JOIN transactions t ON t.id = e.txn_id
         JOIN users u ON u.id = t.initiated_by
         WHERE e.account_id = $1
         UNION ALL
         SELECT 'refused', r.id, r.created_at, r.type, NULL::text, r.amount,
                NULL::bigint, u.email, r.reason, NULL::bigint
         FROM refused_attempts r
         JOIN users u ON u.id = r.user_id
         WHERE r.account_id = $1
       ) s
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      [a.id]
    );
    res.json({ account: { id: a.id, name: a.name, balance: a.balance }, entries: rows });
  } catch (err) {
    console.error('statement failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
