const mongoose = require('mongoose');
const cfg = require('../src/config');
const app = require('../src/app');

let isConnected = false;

async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(cfg.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
  } catch (err) {
    console.warn('MongoDB connection unavailable, running in standalone mode:', err.message);
  }
}

module.exports = async (req, res) => {
  await connectToDatabase();
  return app(req, res);
};
