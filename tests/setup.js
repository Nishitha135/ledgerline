require('dotenv').config({ quiet: true });

// Safety: tests only ever run against the ledgerline_test database.
const owner = process.env.TEST_DATABASE_URL;
if (!owner || new URL(owner).pathname !== '/ledgerline_test') {
  throw new Error('Set TEST_DATABASE_URL in .env pointing at the ledgerline_test database.');
}
const app = process.env.TEST_APP_DATABASE_URL;
if (app && new URL(app).pathname !== '/ledgerline_test') {
  throw new Error('TEST_APP_DATABASE_URL must point at the ledgerline_test database.');
}
// The application under test connects as the least-privilege role, like in production.
process.env.DATABASE_URL = app || owner;
