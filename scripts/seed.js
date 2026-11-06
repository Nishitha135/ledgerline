require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');

// Demo credentials only. They go in the README for the judges.
const USERS = [
  { email: 'admin@ledgerline.test', password: 'AdminDemo#2026', role: 'admin' },
  { email: 'holder@ledgerline.test', password: 'HolderDemo#2026', role: 'holder' },
  { email: 'auditor@ledgerline.test', password: 'AuditorDemo#2026', role: 'auditor' },
];

async function main() {
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
      [u.email, hash, u.role]
    );
  }
  // The "external world" account: counterparty of every deposit and withdrawal.
  await pool.query(
    `INSERT INTO accounts (name, is_system)
     SELECT 'EXTERNAL', true
     WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE is_system)`
  );
  // One account for the demo holder.
  await pool.query(
    `INSERT INTO accounts (owner_id, name)
     SELECT id, 'Holder main account' FROM users
     WHERE email = 'holder@ledgerline.test'
       AND NOT EXISTS (SELECT 1 FROM accounts WHERE owner_id = users.id)`
  );
  console.log('seed complete');
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
