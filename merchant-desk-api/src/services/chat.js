const mongoose = require('mongoose');
const Order = require('../models/Order');
const Message = require('../models/Message');
const { HttpError } = require('../errors');

const isId = (v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);

/** Throws unless user is the order's buyer, its merchant, or an admin. Returns the order. */
async function assertParticipant(orderId, user) {
  if (!isId(orderId)) throw new HttpError(400, 'Invalid order id');
  const order = await Order.findById(orderId).select('merchant buyer');
  if (!order) throw new HttpError(404, 'Order not found');
  const uid = String(user.id || user._id);
  const ok = user.role === 'admin' || String(order.merchant) === uid || String(order.buyer) === uid;
  if (!ok) throw new HttpError(403, 'You are not part of this order');
  return order;
}

const toApi = (m) => ({
  id: m.id,
  order: String(m.order),
  sender: m.sender ? String(m.sender) : null,
  kind: m.kind,
  text: m.text,
  createdAt: m.createdAt
});

async function sendMessage({ orderId, user, text }) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body || body.length > 500) throw new HttpError(400, 'Messages must be 1 to 500 characters');
  await assertParticipant(orderId, user);
  const uid = String(user.id || user._id);
  const m = await Message.create({ order: orderId, sender: uid, kind: 'user', text: body, readBy: [uid] });
  return toApi(m);
}

async function listMessages({ orderId, user, before, limit = 50 }) {
  await assertParticipant(orderId, user);
  const uid = String(user.id || user._id);
  const q = { order: orderId };
  if (before) q.createdAt = { $lt: new Date(before) };
  const rows = await Message.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 100));
  await Message.updateMany(
    { order: orderId, readBy: { $ne: new mongoose.Types.ObjectId(uid) } },
    { $addToSet: { readBy: uid } }
  );
  return rows.reverse().map(toApi);
}

module.exports = { assertParticipant, sendMessage, listMessages, toApi };
