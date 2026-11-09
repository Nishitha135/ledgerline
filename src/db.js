require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// An idle connection can be closed by the database (Neon suspends idle compute).
// Without a handler Node treats this 'error' event as fatal and the process exits.
pool.on('error', (err) => console.error('idle database client error:', err.message));

// Runs fn inside ONE transaction: commit on success, rollback on any error.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTx };
