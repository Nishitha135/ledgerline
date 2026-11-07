const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { pool } = require('../db');
const { runIdempotent, depositWork, withdrawWork, transferWork } = require('../services/ledger');

const router = express.Router();

const KEY_RE = /^[\w.:-]{8,128}$/;
const idSchema = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(z.string().regex(/^[1-9]\d{0,17}$/));
const amountSchema = z.number().int().positive().max(1_000_000_000_000); // paise

// Role gate that leaves a trace: a role that may not move money at all (auditor, or admin
// withdrawing) is refused AND the attempt is written to refused_attempts.
// Holders pass every gate here, so a holder cannot use it to add rows.
function roleGate(type, allowed) {
  return async (req, res, next) => {
    if (allowed.includes(req.user.role)) return next();
    try {
      const target = req.params.id ? ` on account ${req.params.id}` : '';
      await pool.query(
        `INSERT INTO refused_attempts (user_id, account_id, type, amount, reason, idempotency_key, created_at)
         VALUES ($1, NULL, $2, NULL, $3, $4, clock_timestamp())`,
        [req.user.id, type, `role ${req.user.role} may not move money (${type})${target}`,
          (req.get('Idempotency-Key') || '').slice(0, 128) || null]
      );
    } catch (err) {
      console.error('role refusal log failed:', err.message);
    }
    return res.status(403).json({ error: 'forbidden' });
  };
}

async function execute(req, res, type, fields, makeWork) {
  const key = req.get('Idempotency-Key');
  if (!key || !KEY_RE.test(key)) {
    return res.status(400).json({
      error: 'Idempotency-Key header required (8-128 chars: letters, digits, _ . : -)',
    });
  }
  // Hash of the validated fields, so key order in the JSON body does not matter.
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ type, ...fields }))
    .digest('hex');
  const ctx = { user: req.user, key, type, amount: fields.amount };
  try {
    const r = await runIdempotent({ user: req.user, key, requestHash }, makeWork(ctx));
    if (r.replayed) res.set('Idempotent-Replayed', 'true');
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error(`${type} failed:`, err.message);
    res.status(500).json({ error: 'internal error' });
  }
}

router.post('/accounts/:id/deposit', authenticate, roleGate('deposit', ['admin', 'holder']), (req, res) => {
  const p = z.object({ accountId: idSchema, amount: amountSchema })
    .safeParse({ accountId: req.params.id, amount: (req.body || {}).amount });
  if (!p.success) return res.status(400).json({ error: 'invalid account id or amount (positive integer, in paise)' });
  const { accountId, amount } = p.data;
  return execute(req, res, 'deposit', { accountId, amount: String(amount) },
    (ctx) => depositWork(ctx, accountId));
});

router.post('/accounts/:id/withdraw', authenticate, roleGate('withdrawal', ['holder']), (req, res) => {
  const p = z.object({ accountId: idSchema, amount: amountSchema })
    .safeParse({ accountId: req.params.id, amount: (req.body || {}).amount });
  if (!p.success) return res.status(400).json({ error: 'invalid account id or amount (positive integer, in paise)' });
  const { accountId, amount } = p.data;
  return execute(req, res, 'withdrawal', { accountId, amount: String(amount) },
    (ctx) => withdrawWork(ctx, accountId));
});

router.post('/transfers', authenticate, roleGate('transfer', ['holder']), (req, res) => {
  const b = req.body || {};
  const p = z.object({ fromAccountId: idSchema, toAccountId: idSchema, amount: amountSchema })
    .safeParse({ fromAccountId: b.fromAccountId, toAccountId: b.toAccountId, amount: b.amount });
  if (!p.success) return res.status(400).json({ error: 'invalid fromAccountId, toAccountId or amount (positive integer, in paise)' });
  const { fromAccountId, toAccountId, amount } = p.data;
  return execute(req, res, 'transfer', { fromAccountId, toAccountId, amount: String(amount) },
    (ctx) => transferWork(ctx, fromAccountId, toAccountId));
});

module.exports = router;
