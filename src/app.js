const express = require('express');
const helmet = require('helmet');
const { pool } = require('./db');
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/accounts');
const moneyRoutes = require('./routes/money');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('health check failed:', err.message);
    res.status(500).json({ status: 'db down' });
  }
});

app.use('/auth', authRoutes);
app.use('/accounts', accountRoutes);
app.use('/', moneyRoutes);

// Malformed JSON and anything unexpected: JSON errors, no stack traces.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error('unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
