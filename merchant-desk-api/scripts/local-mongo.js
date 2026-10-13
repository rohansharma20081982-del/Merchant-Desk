const { MongoMemoryReplSet } = require('mongodb-memory-server');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', '.mongo-data');
if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });

(async () => {
  console.log('Starting local MongoDB replica set on port 27017...');
  try {
    const replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
      instanceOpts: [
        {
          port: 27017,
          dbPath
        }
      ]
    });
    console.log('MongoDB Replica Set is running at: mongodb://127.0.0.1:27017/merchant_desk?replicaSet=rs0');
    console.log('Database storage directory: .mongo-data/');

    const stop = async () => {
      console.log('Shutting down local MongoDB...');
      await replSet.stop();
      process.exit(0);
    };

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    if (err.message && err.message.includes('EADDRINUSE')) {
      console.log('MongoDB is already running on port 27017.');
      return;
    }
    console.error('Failed to start local MongoDB:', err);
    process.exit(1);
  }
})();
