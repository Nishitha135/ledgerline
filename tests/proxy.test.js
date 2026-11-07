const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/db');

// Pins the proxy setting. The client address must come from the right-hand side of
// X-Forwarded-For, so a client cannot pick its own address to dodge the rate limit.
app.get('/__test_ip', (req, res) => res.json({ ip: req.ip }));
afterAll(() => pool.end());

test('trust proxy: the client ip is the address three hops in', async () => {
  const res = await request(app).get('/__test_ip')
    .set('X-Forwarded-For', '117.192.194.141, 104.22.66.67, 10.24.209.5');
  expect(res.body.ip).toBe('117.192.194.141');
});

test('a spoofed leftmost X-Forwarded-For entry is ignored', async () => {
  const res = await request(app).get('/__test_ip')
    .set('X-Forwarded-For', '6.6.6.6, 117.192.194.141, 104.22.66.67, 10.24.209.5');
  expect(res.body.ip).toBe('117.192.194.141');
});
