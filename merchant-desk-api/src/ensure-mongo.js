const net = require('net');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');

async function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Ensures MongoDB is available if configured for local replica set.
 * If 127.0.0.1:27017 is not yet running, spins up an embedded single-node replica set.
 */
async function ensureMongo() {
  const isLocal = cfg.mongoUri.includes('127.0.0.1:27017') || cfg.mongoUri.includes('localhost:27017');
  if (!isLocal) return null;

  const running = await isPortOpen(27017);
  if (running) return null;

  console.log('No local MongoDB detected. Starting embedded replica set on port 27017...');
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const dbPath = path.join(__dirname, '..', '.mongo-data');
  if (!fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });

  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: 27017, dbPath }]
  });

  console.log('Embedded MongoDB replica set is running on port 27017 (data saved to .mongo-data/).');
  return replSet;
}

module.exports = { ensureMongo };
