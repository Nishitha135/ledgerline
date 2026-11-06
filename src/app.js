const express = require('express');
const helmet = require('helmet');
const { pool } = require('./db');

const app = express();
app.use(helmet());
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('health check failed:', err.message);
    res.status(500).json({ status: 'db down' });
  }
});

module.exports = app;
