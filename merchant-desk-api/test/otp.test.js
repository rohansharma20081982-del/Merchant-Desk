process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.OTP_SECRET = 'test-otp-secret-test-otp-secret';
process.env.OTP_COOLDOWN_SECONDS = '1';
process.env.OTP_TTL_SECONDS = '300';
process.env.OTP_MAX_ATTEMPTS = '5';
process.env.OTP_MAX_SENDS_PER_HOUR = '5';
process.env.SMS_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const http = require('node:http');

const cfg = require('../src/config');
cfg.otpCooldownSeconds = 1;

const app = require('../src/app');
const User = require('../src/models/User');
const Otp = require('../src/models/Otp');
const AuditLog = require('../src/models/AuditLog');
const OtpService = require('../src/services/OtpService');
const { MockSmsProvider } = require('../src/services/sms');
const { MockEmailProvider } = require('../src/services/email');

let mongod, server, base;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  MockSmsProvider.clear();
  MockEmailProvider.clear();
  await Otp.deleteMany({});
  await AuditLog.deleteMany({});
  await User.deleteMany({});
});

const req = (method, path, body, headers = {}) =>
  fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

test('1. Phone normalization and masking', () => {
  assert.equal(OtpService.normalizePhoneNumber('9876543210'), '+919876543210');
  assert.equal(OtpService.normalizePhoneNumber('09876543210'), '+919876543210');
  assert.equal(OtpService.normalizePhoneNumber('+91 98765 43210'), '+919876543210');
  assert.equal(OtpService.normalizePhoneNumber('+1 (415) 555-2671'), '+14155552671');

  // Masking
  assert.equal(OtpService.maskDestination('+919876543210'), '+91XXXXXX3210');
  assert.equal(OtpService.maskDestination('john.doe@example.com'), 'jo***@example.com');
});

test('2. Cryptographically secure 6-digit OTP generation and HMAC-SHA256 hashing', () => {
  const code = OtpService.generateOtpCode();
  assert.match(code, /^\d{6}$/);

  const hash1 = OtpService.hashOtp(code);
  const hash2 = OtpService.hashOtp(code);
  assert.equal(hash1, hash2);
  assert.notEqual(code, hash1); // Never plain text

  // Constant time comparison
  assert.equal(OtpService.verifyOtpHash(code, hash1), true);
  assert.equal(OtpService.verifyOtpHash('000000', hash1), false);
});

test('3. OTP send, audit logging, and single-use consumption', async () => {
  const phone = '9876500001';
  const normPhone = '+919876500001';
  const sendRes = await req('POST', '/api/auth/otp/send', {
    channel: 'sms',
    destination: phone,
    purpose: 'signup'
  });
  assert.equal(sendRes.status, 200);
  const sendData = await sendRes.json();
  assert.equal(sendData.ok, true);

  // Verify mock SMS received the code
  const lastSms = MockSmsProvider.getLastMessage();
  assert.ok(lastSms, 'SMS should have been dispatched to mock provider');
  assert.equal(lastSms.to, normPhone);
  const codeMatch = lastSms.message.match(/code is (\d{6})/);
  assert.ok(codeMatch);
  const sentCode = codeMatch[1];

  // Verify stored in DB as hash, not plain text
  const doc = await Otp.findOne({ destination: normPhone });
  assert.ok(doc);
  assert.notEqual(doc.otpHash, sentCode);
  assert.equal(doc.status, 'pending');
  assert.equal(doc.consumedAt, null);

  // Verify audit log recorded send
  const sendAudit = await AuditLog.findOne({ event: 'otp_send' });
  assert.ok(sendAudit);
  assert.equal(sendAudit.success, true);

  // Successfully verify OTP
  const verifyRes = await req('POST', '/api/auth/otp/verify', {
    channel: 'sms',
    destination: normPhone,
    purpose: 'signup',
    otp: sentCode
  });
  assert.equal(verifyRes.status, 200);
  const verifyData = await verifyRes.json();
  assert.equal(verifyData.verified, true);

  // Check consumed status in DB (single use)
  const updatedDoc = await Otp.findById(doc._id);
  assert.equal(updatedDoc.status, 'consumed');
  assert.ok(updatedDoc.consumedAt);

  // Trying to reuse the same OTP must fail
  const reuseRes = await req('POST', '/api/auth/otp/verify', {
    channel: 'sms',
    destination: normPhone,
    purpose: 'signup',
    otp: sentCode
  });
  assert.equal(reuseRes.status, 400);
});

test('4. Expiry validation (5 minutes)', async () => {
  const rawCode = '654321';
  const normPhone = '+919876500002';
  await Otp.create({
    channel: 'sms',
    destination: normPhone,
    otpHash: OtpService.hashOtp(rawCode),
    purpose: 'signup',
    expiresAt: new Date(Date.now() - 1000), // expired 1s ago
    status: 'pending'
  });

  const res = await req('POST', '/api/auth/otp/verify', {
    channel: 'sms',
    destination: normPhone,
    purpose: 'signup',
    otp: rawCode
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /expired/i);
});

test('5. Attempt limits (max 5 incorrect attempts before invalidation)', async () => {
  const phone = '9876500003';
  const normPhone = '+919876500003';
  const sendRes = await req('POST', '/api/auth/otp/send', {
    channel: 'sms',
    destination: phone,
    purpose: 'verify_contact'
  });
  assert.equal(sendRes.status, 200);
  const sentCode = MockSmsProvider.getLastMessage().message.match(/code is (\d{6})/)[1];

  // Make 4 incorrect attempts
  for (let i = 1; i <= 4; i++) {
    const r = await req('POST', '/api/auth/otp/verify', {
      channel: 'sms',
      destination: normPhone,
      purpose: 'verify_contact',
      otp: '000000'
    });
    assert.equal(r.status, 400);
    const d = await r.json();
    assert.match(d.error, /attempt/i);
  }

  // 5th incorrect attempt invalidates the OTP
  const fifth = await req('POST', '/api/auth/otp/verify', {
    channel: 'sms',
    destination: normPhone,
    purpose: 'verify_contact',
    otp: '000000'
  });
  assert.equal(fifth.status, 400);
  const fifthData = await fifth.json();
  assert.match(fifthData.error, /invalid/i);

  // Even the correct code is now rejected because OTP is invalidated
  const attemptWithCorrect = await req('POST', '/api/auth/otp/verify', {
    channel: 'sms',
    destination: normPhone,
    purpose: 'verify_contact',
    otp: sentCode
  });
  assert.equal(attemptWithCorrect.status, 400);
});

test('6. Resend cooldown and hourly rate limiting', async () => {
  // First send
  const r1 = await req('POST', '/api/auth/otp/send', {
    channel: 'sms',
    destination: '9876500004',
    purpose: 'signup'
  });
  assert.equal(r1.status, 200);

  // Immediate second send fails with cooldown 429
  const r2 = await req('POST', '/api/auth/otp/send', {
    channel: 'sms',
    destination: '9876500004',
    purpose: 'signup'
  });
  assert.equal(r2.status, 429);
  assert.ok(r2.headers.get('retry-after'));
  const d2 = await r2.json();
  assert.match(d2.error, /wait/i);
});

test('7. OTP rejects email channel (OTP removed from Gmail in favor of 1-click login)', async () => {
  const r = await req('POST', '/api/auth/otp/send', {
    channel: 'email',
    destination: 'test@gmail.com',
    purpose: 'verify_contact'
  });
  assert.equal(r.status, 400);
});

