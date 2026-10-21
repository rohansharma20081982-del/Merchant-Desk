process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');
const { verifyGoogleToken } = require('../src/services/googleAuth');
const { HttpError } = require('../src/errors');

let mongod, server, base;
test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  if (mongod) {
    await mongoose.disconnect();
    await mongod.stop();
  }
});

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

test('1-click gmail login logs in or creates user without OTP', async () => {
  const r = await req('POST', '/api/auth/google', {
    email: 'oneclick@gmail.com',
    role: 'buyer'
  });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.ok(j.token);
  assert.equal(j.user.email, 'oneclick@gmail.com');
  assert.equal(j.user.emailVerified, true);
  assert.equal(j.user.authProvider, 'google');
  assert.equal(j.isNewUser, true);

  // Calling again logs in existing user seamlessly
  const r2 = await req('POST', '/api/auth/gmail', {
    email: 'oneclick@gmail.com'
  });
  assert.equal(r2.status, 200);
  const j2 = await r2.json();
  assert.ok(j2.token);
  assert.equal(j2.isNewUser, false);
});

test('create account dispatches click-to-verify email and verifies via link token', async () => {
  const email = 'newtrader@gmail.com';
  const regRes = await req('POST', '/api/auth/register', {
    name: 'New Trader',
    email,
    password: 'password12345',
    role: 'buyer'
  });
  assert.equal(regRes.status, 201);
  const regData = await regRes.json();
  assert.ok(regData.verifyUrl, 'Should return verifyUrl in non-production');
  assert.equal(regData.user.emailVerified, false);

  // Extract raw token from verifyUrl
  const rawToken = regData.verifyUrl.split('verify_email=')[1];
  assert.ok(rawToken);

  // Call verify-email endpoint with token
  const verifyRes = await req('POST', '/api/auth/verify-email', { token: rawToken });
  assert.equal(verifyRes.status, 200);
  const verifyData = await verifyRes.json();
  assert.equal(verifyData.verified, true);
  assert.equal(verifyData.user.emailVerified, true);
  assert.ok(verifyData.token);

  // Calling with invalid or expired token fails with 400
  const invalidRes = await req('POST', '/api/auth/verify-email', { token: 'invalid_token_12345' });
  assert.equal(invalidRes.status, 400);
});


