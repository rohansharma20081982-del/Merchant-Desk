process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');
const { verifyGoogleToken } = require('../src/services/googleAuth');
const { HttpError } = require('../src/errors');

let server, base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const req = (method, path, body, headers = {}) =>
  fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

test('google login route validates input', async () => {
  const r = await req('POST', '/api/auth/google', {});
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(j.fields && j.fields.some((f) => f.path.includes('credential')));
});

test('google login rejects short or malformed credential token', async () => {
  const r = await req('POST', '/api/auth/google', { credential: 'short' });
  assert.equal(r.status, 400);
});

test('googleAuth service rejects missing or non-string token', async () => {
  await assert.rejects(async () => {
    await verifyGoogleToken(null);
  }, HttpError);
});

test('googleAuth service rejects fake token when verifying with Google', async () => {
  await assert.rejects(async () => {
    await verifyGoogleToken('fake.header.payload');
  }, /Invalid or expired Google credential|Unable to verify/i);
});

test('/api/config exposes googleClientId and CSP permits Google Identity Services', async () => {
  const r = await req('GET', '/api/config');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(typeof j, 'object');
  assert.ok('googleClientId' in j);

  const home = await req('GET', '/');
  const csp = home.headers.get('content-security-policy') || '';
  assert.match(csp, /accounts\.google\.com/);
});
