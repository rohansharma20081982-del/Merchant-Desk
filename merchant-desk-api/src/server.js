const http = require('http');
const mongoose = require('mongoose');
const cfg = require('./config');
const app = require('./app');
const realtime = require('./realtime');
const orders = require('./services/orders');

const { ensureMongo } = require('./ensure-mongo');

async function main() {
  const localMongo = await ensureMongo();
  mongoose.set('strictQuery', true);
  await mongoose.connect(cfg.mongoUri);
  // Build indexes before serving traffic (unique UPI ID, one open dispute per order, and so on).
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  const server = http.createServer(app);
  realtime.init(server);

  // Cancel unpaid orders when their payment window closes, and return the USDT to the merchant.
  const sweep = setInterval(() => orders.expireOrders().catch((e) => console.error('sweep failed:', e.message)), 30 * 1000);

  server.listen(cfg.port, () => console.log(`Merchant Desk API listening on :${cfg.port}`));

  const stop = async () => {
    clearInterval(sweep);
    server.close();
    await mongoose.disconnect();
    if (localMongo) await localMongo.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
