process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');
const realtime = require('../src/realtime');
const User = require('../src/models/User');

let server, base;
test.before(async () => {
  server = http.createServer(app);
  realtime.init(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const req = (method, path, body, headers = {}) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });

test('CSRF protection blocks spoofed localhost origin domains', async () => {
  // Attacker hosting site at evil-localhost.com or localhost.attacker.com
  const r = await req('POST', '/api/auth/register', { name: 'A' }, {
    'Origin': 'https://evil-localhost.com',
    'X-Requested-With': 'XMLHttpRequest'
  });
  assert.equal(r.status, 403);
  const data = await r.json();
  assert.match(data.error, /CSRF/i);
});

test('CSRF protection accepts legitimate localhost and configured origins', async () => {
  const r = await req('POST', '/api/auth/register', { name: 'A' }, {
    'Origin': 'http://localhost:3000',
    'X-Requested-With': 'XMLHttpRequest'
  });
  // Should pass CSRF middleware and reach route validation (returns 400, not 403 CSRF)
  assert.equal(r.status, 400);
  const data = await r.json();
  assert.ok(data.fields && data.fields.length > 0);
});

test('User schema enforces unique constraint on phone', () => {
  const phonePath = User.schema.path('phone');
  assert.ok(phonePath);
  assert.equal(phonePath.options.unique, true, 'Phone must have unique: true');
  assert.equal(phonePath.options.sparse, true, 'Phone must have sparse: true');
});
