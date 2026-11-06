require('dotenv').config({ quiet: true });

// Safety: tests only ever run against the ledgerline_test database.
const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== '/ledgerline_test') {
  throw new Error('Set TEST_DATABASE_URL in .env pointing at the ledgerline_test database.');
}
process.env.DATABASE_URL = url;
