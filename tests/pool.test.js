const { pool } = require('../src/db');

afterAll(() => pool.end());

test('the database pool has an error handler, so a dropped idle connection cannot crash the server', () => {
  expect(pool.listenerCount('error')).toBeGreaterThan(0);
});
