const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { pool } = require('./db');
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/accounts');
const auditRoutes = require('./routes/audit');
const moneyRoutes = require('./routes/money');

const app = express();
// Render: loopback, internal proxy, Cloudflare in front of the app (measured from X-Forwarded-For).
app.set('trust proxy', 3);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],       // no inline scripts: a script injected into the page cannot run
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
}));
app.use(express.json({ limit: '10kb' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

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
app.use('/audit', auditRoutes);
app.use('/', moneyRoutes);

// Malformed JSON and anything unexpected: JSON errors, no stack traces.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error('unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

module.exports = app;
