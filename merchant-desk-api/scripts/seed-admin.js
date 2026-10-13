// Creates the support/admin account. Admins cannot be created over the public API.
// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long password' npm run seed:admin
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const cfg = require('../src/config');
const User = require('../src/models/User');
const { ensureMongo } = require('../src/ensure-mongo');

(async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || password.length < 12) {
    console.error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
    process.exit(1);
  }
  const localMongo = await ensureMongo();
  await mongoose.connect(cfg.mongoUri);
  await User.init();
  if (await User.exists({ email })) {
    console.log('An account with this email already exists. Nothing changed.');
  } else {
    await User.create({ name: 'Support', email, role: 'admin', passwordHash: await bcrypt.hash(password, 12) });
    console.log('Admin created:', email);
  }
  await mongoose.disconnect();
  if (localMongo) await localMongo.stop();
})().catch((e) => { console.error(e); process.exit(1); });
