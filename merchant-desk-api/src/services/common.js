const mongoose = require('mongoose');
const LedgerEntry = require('../models/LedgerEntry');
const Message = require('../models/Message');

/** Run fn inside a MongoDB transaction. Throwing aborts everything fn wrote. */
async function withTx(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}

async function ledger(entries, session) {
  await LedgerEntry.create(entries, { session, ordered: true });
}

/** Post a system line into the order's chat (inside the caller's transaction). */
async function sys(orderId, text, session) {
  const [m] = await Message.create([{ order: orderId, kind: 'system', text }], { session });
  return m;
}

const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const usdt = (minor) => (minor / 100).toFixed(2) + ' USDT';

module.exports = { withTx, ledger, sys, inr, usdt };
