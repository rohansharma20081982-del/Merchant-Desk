const mongoose = require('mongoose');
const cfg = require('../src/config');
const app = require('../src/app');

let isConnected = false;

async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) {
    return;
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(cfg.mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });
  isConnected = true;
}

module.exports = async (req, res) => {
  try {
    await connectToDatabase();
    return app(req, res);
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({ error: 'Database connection failed', details: err.message });
  }
};
