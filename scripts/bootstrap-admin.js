'use strict';
// First-admin bootstrap. Creates the very first administrator, and refuses once any administrator exists.
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long password' npm run bootstrap-admin
// It runs against DATABASE_URL. The limited ledger_app role is enough (it may insert users and accounts).
// The password comes from the environment, never from the command line or the repository.
const bcrypt = require('bcryptjs');

const MIN_PASSWORD = 12;

async function bootstrapAdmin(pool, { email, password }) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('ADMIN_EMAIL must be a valid email address');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters`);
  }
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One bootstrap at a time: two runs at once cannot both create an administrator.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ledgerline-bootstrap-admin', 0))");
    const { rows } = await client.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");
    if (rows.length) {
      await client.query('ROLLBACK');
      return { created: false, reason: 'an administrator already exists' };
    }
    await client.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')", [e, hash]);
    // The EXTERNAL account is the other side of every deposit and withdrawal.
    await client.query(
      `INSERT INTO accounts (name, is_system)
       SELECT 'EXTERNAL', true WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE is_system)`
    );
    await client.query('COMMIT');
    return { created: true, email: e };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { bootstrapAdmin, MIN_PASSWORD };

if (require.main === module) {
  const { pool } = require('../src/db');
  bootstrapAdmin(pool, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
    .then((r) => {
      console.log(r.created ? `Administrator created: ${r.email}` : `Nothing done: ${r.reason}`);
      return pool.end();
    })
    .catch((err) => {
      console.error(`Bootstrap failed: ${err.message}`);
      process.exit(1);
    });
}
