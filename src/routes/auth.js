const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { pool } = require('../db');
const { jwtSecret, jwtExpiresIn } = require('../config');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const credentials = z.object({
  email: z.string().email().max(200).transform((s) => s.toLowerCase()),
  password: z.string().min(8).max(200),
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50 });

// A real bcrypt hash, so unknown emails take as long as known ones.
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

router.post('/register', loginLimiter, async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid email or password (min 8 chars)' });
  const { email, password } = parsed.data;
  try {
    const hash = await bcrypt.hash(password, 10);
    // Role is ALWAYS holder here. Admins and auditors are never self-created.
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'holder') RETURNING id, email, role",
      [email, hash]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email already registered' });
    console.error('register failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid email or password' });
  const { email, password } = parsed.data;
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'wrong email or password' });
    const token = jwt.sign({ sub: String(user.id) }, jwtSecret, {
      algorithm: 'HS256',
      expiresIn: jwtExpiresIn,
    });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    console.error('login failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

router.get('/me', authenticate, (req, res) => res.json(req.user));

module.exports = router;
