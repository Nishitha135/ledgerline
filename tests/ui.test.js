const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/db');

afterAll(() => pool.end());

test('the app is served and the CSP forbids inline scripts', async () => {
  const page = await request(app).get('/');
  expect(page.status).toBe(200);
  expect(page.headers['content-type']).toMatch(/html/);
  const csp = page.headers['content-security-policy'];
  expect(csp).toMatch(/script-src 'self'/);
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect((await request(app).get('/app.js')).status).toBe(200);
  expect((await request(app).get('/style.css')).status).toBe(200);
});

test('the page has no inline script and no inline event handlers', async () => {
  const page = await request(app).get('/');
  expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)/i);
  expect(page.text).not.toMatch(/\son[a-z]+\s*=/i);
});

test('the client never builds markup from strings (untrusted text only goes in as text)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('signing out clears what the previous user saw (the page is not reloaded)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const reset = src.slice(src.indexOf('function resetView'), src.indexOf('function logout'));
  for (const id of ['result', 'statement', 'accounts', 'reconcile', 'refused']) {
    expect(reset).toContain(`$('${id}')`);
  }
  const logout = src.slice(src.indexOf('function logout'), src.indexOf('function render'));
  expect(logout).toContain('resetView()');
});
