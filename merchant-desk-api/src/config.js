require('dotenv').config();
const dns = require('node:dns');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

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

  // All money is stored as integers: USDT in hundredths, INR in paise.
  rateMinor: Math.round(rateInr * 100), // paise per 1 USDT
  minOrderMinor: 500 * 100, // Rs 500
  maxOrderMinor: 100000 * 100, // Rs 1,00,000
  dailyLimitMinor: 500000 * 100, // Rs 5,00,000 per merchant per day
  paymentWindowMs: 15 * 60 * 1000
};
