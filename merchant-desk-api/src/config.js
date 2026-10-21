require('dotenv').config();
if (!process.env.VERCEL) {
  try {
    const dns = require('node:dns');
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch (_) {}
}

const need = (key) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
};

const rateInr = Number(process.env.RATE_INR_PER_USDT || 109);
if (!Number.isFinite(rateInr) || rateInr <= 0) throw new Error('RATE_INR_PER_USDT must be a positive number');

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/merchant_desk?replicaSet=rs0',
  jwtSecret: need('JWT_SECRET'),
  jwtTtl: '7d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
  uploadDir: process.env.UPLOAD_DIR || (process.env.VERCEL ? '/tmp/uploads' : 'uploads'),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',

  // All money is stored as integers: USDT in hundredths, INR in paise.
  rateMinor: Math.round(rateInr * 100), // paise per 1 USDT
  minOrderMinor: 500 * 100, // Rs 500
  maxOrderMinor: 100000 * 100, // Rs 1,00,000
  dailyLimitMinor: 500000 * 100, // Rs 5,00,000 per merchant per day
  paymentWindowMs: 15 * 60 * 1000,

  // App & Brand
  appName: process.env.APP_NAME || 'Merchant Desk',

  // OTP Configuration
  otpSecret: process.env.OTP_SECRET || need('JWT_SECRET'),
  otpTtlSeconds: Number(process.env.OTP_TTL_SECONDS || 300), // 5 minutes
  otpCooldownSeconds: Number(process.env.OTP_COOLDOWN_SECONDS || 60), // 60 seconds
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
  otpMaxSendsPerHour: Number(process.env.OTP_MAX_SENDS_PER_HOUR || 5),

  // Verification requirements at signup
  requirePhoneVerification: process.env.REQUIRE_PHONE_VERIFICATION === 'true',
  requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',

  // SMS Provider settings
  smsProvider: (process.env.SMS_PROVIDER || 'mock').toLowerCase(),
  smsSenderId: process.env.SMS_SENDER_ID || 'MRCHNT',
  smsTemplateId: process.env.SMS_DLT_TE_ID || '1007161234567890123',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  msg91AuthKey: process.env.MSG91_AUTH_KEY || '',
  msg91SenderId: process.env.MSG91_SENDER_ID || '',
  fast2smsApiKey: process.env.FAST2SMS_API_KEY || '',

  // Email Provider settings
  emailProvider: (process.env.EMAIL_PROVIDER || 'mock').toLowerCase(),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  emailFrom: process.env.EMAIL_FROM || 'no-reply@merchantdesk.local'
};
