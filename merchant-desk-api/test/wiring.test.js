// Checks that the app boots and the guards run before any database call. No MongoDB needed.
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');

let server, base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const req = (method, path, body, headers = {}) =>
  fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

test('health check', async () => assert.equal((await req('GET', '/healthz')).status, 200));

test('protected routes need a token', async () => {
  for (const p of ['/api/me', '/api/orders', '/api/disputes', '/api/admin/kyc']) {
    assert.equal((await req('GET', p)).status, 401, p);
  }
});

test('a garbage token is refused', async () => {
  assert.equal((await req('GET', '/api/me', null, { Authorization: 'Bearer nope' })).status, 401);
});

test('registration validates input before touching the database', async () => {
  const r = await req('POST', '/api/auth/register', { name: 'A', email: 'not-an-email', password: 'short', role: 'admin' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(j.fields.length >= 3);
});

test('serves the mobile app and its install files', async () => {
  const home = await req('GET', '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /USDT Merchant Desk/);
  const csp = home.headers.get('content-security-policy') || '';
  assert.match(csp, /connect-src 'self' ws: wss:/);
  assert.ok(!csp.includes('upgrade-insecure-requests'));
  for (const p of ['/app.js', '/styles.css', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
    assert.equal((await req('GET', p)).status, 200, p);
  }
  const cfgRes = await req('GET', '/api/config');
  assert.equal(cfgRes.status, 200);
  assert.equal((await cfgRes.json()).paymentWindowMinutes, 15);
});

test('unknown routes return 404 json', async () => {
  const r = await req('GET', '/api/nothing-here');
  assert.equal(r.status, 404);
});
