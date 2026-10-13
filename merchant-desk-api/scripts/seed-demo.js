// Development only: one verified merchant (300 USDT, online) and one verified buyer, with random passwords.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const cfg = require('../src/config');
const User = require('../src/models/User');
const { ensureMongo } = require('../src/ensure-mongo');

if (cfg.env === 'production') {
  console.error('seed:demo is for development only.');
  process.exit(1);
}

(async () => {
  const localMongo = await ensureMongo();
  await mongoose.connect(cfg.mongoUri);
  await User.init();
  const out = [];
  const make = async (doc) => {
    if (await User.exists({ email: doc.email })) return console.log(`${doc.email} already exists, skipped`);
    const password = crypto.randomBytes(9).toString('base64url');
    await User.create({ ...doc, passwordHash: await bcrypt.hash(password, 12) });
    out.push(`${doc.role.padEnd(8)} ${doc.email}  password: ${password}`);
  };
  const verified = (legalName) => ({ status: 'verified', legalName, panLast4: 'ABCD', submittedAt: new Date(), reviewedAt: new Date() });

  await make({
    name: 'Meera Nair', email: 'meera@example.test', role: 'merchant', online: true,
    kyc: verified('MEERA NAIR'),
    paymentAccount: { upi: 'meera.nair@okhdfcbank', holderName: 'MEERA NAIR', verifiedAt: new Date() },
    balance: { available: 300 * 100, escrow: 0 }
  });
  await make({ name: 'Aman Kapoor', email: 'aman@example.test', role: 'buyer', kyc: verified('AMAN KAPOOR') });

  console.log(out.length ? out.join('\n') : 'Nothing created.');
  await mongoose.disconnect();
  if (localMongo) await localMongo.stop();
})().catch((e) => { console.error(e); process.exit(1); });
