const mongoose = require('mongoose');
const cfg = require('../src/config');
const { ensureMongo } = require('../src/ensure-mongo');

// Register all models
require('../src/models/User');
require('../src/models/Order');
require('../src/models/Dispute');
require('../src/models/Message');
require('../src/models/LedgerEntry');
require('../src/models/AuditLog');
require('../src/models/Otp');
require('../src/models/SupportConversation');
require('../src/models/SupportMessage');

async function main() {
  const safeUri = cfg.mongoUri.replace(/:([^@]+)@/, ':****@');
  console.log(`Connecting to MongoDB (${safeUri})...`);
  const localMongo = await ensureMongo();
  await mongoose.connect(cfg.mongoUri);

  console.log('Dropping all collections...');
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) {
    console.log(`- Dropping collection: ${collection.collectionName}`);
    await collection.drop().catch(() => {});
  }

  console.log('Rebuilding model indexes...');
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  console.log('✅ MongoDB reset successfully! All collections cleared and ready.');
  await mongoose.disconnect();
  if (localMongo) await localMongo.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Reset database failed:', err);
  process.exit(1);
});
