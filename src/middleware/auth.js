const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');
const { pool } = require('../db');

// Verifies the token, then loads the user's CURRENT role from the database.
async function authenticate(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing token' });
  }
  try {
    const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    const { rows } = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [payload.sub]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'invalid token' });
    req.user = rows[0];
    next();
  } catch (err) {
    res.status(401).json({ error: 'invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'forbidden' });
}

module.exports = { authenticate, requireRole };
