const cfg = require('../config');
const User = require('../models/User');
const Order = require('../models/Order');
const { HttpError } = require('../errors');
const { inrFor } = require('../money');
const { withTx, ledger, sys, inr, usdt } = require('./common');
const rt = require('../realtime');

/* ---- balance movements (always called inside a transaction) ---- */

/** Escrow goes back to the merchant's available balance. */
async function returnToMerchant(order, session) {
  const m = await User.findOneAndUpdate(
    { _id: order.merchant, 'balance.escrow': { $gte: order.usdtMinor } },
    { $inc: { 'balance.escrow': -order.usdtMinor, 'balance.available': order.usdtMinor } },
    { new: true, session }
  );
  if (!m) throw new HttpError(500, 'Escrow balance mismatch');
  await ledger(
    [{ user: m._id, order: order._id, type: 'escrow_return', amountMinor: order.usdtMinor,
       availableAfter: m.balance.available, escrowAfter: m.balance.escrow }],
    session
  );
}

/** Escrow leaves the merchant and lands in the buyer's available balance. */
async function moveToBuyer(order, session) {
  const m = await User.findOneAndUpdate(
    { _id: order.merchant, 'balance.escrow': { $gte: order.usdtMinor } },
    { $inc: { 'balance.escrow': -order.usdtMinor } },
    { new: true, session }
  );
  if (!m) throw new HttpError(500, 'Escrow balance mismatch');
  const b = await User.findByIdAndUpdate(
    order.buyer,
    { $inc: { 'balance.available': order.usdtMinor } },
    { new: true, session }
  );
  if (!b) throw new HttpError(500, 'Buyer account missing');
  await ledger(
    [
      { user: m._id, order: order._id, type: 'escrow_release', amountMinor: order.usdtMinor,
        availableAfter: m.balance.available, escrowAfter: m.balance.escrow },
      { user: b._id, order: order._id, type: 'received_from_escrow', amountMinor: order.usdtMinor,
        availableAfter: b.balance.available, escrowAfter: b.balance.escrow }
    ],
    session
  );
}

/* ---- order lifecycle ---- */

async function createOrder({ buyer, merchantId, usdtMinor }) {
  if (buyer.role !== 'buyer') throw new HttpError(403, 'Only buyer accounts can place orders');
  if (buyer.kyc.status !== 'verified') throw new HttpError(403, 'Complete identity verification before placing orders');

  const inrMinor = inrFor(usdtMinor, cfg.rateMinor);
  if (inrMinor < cfg.minOrderMinor || inrMinor > cfg.maxOrderMinor) {
    throw new HttpError(400, 'Order value must be between ₹500 and ₹1,00,000');
  }

  const order = await withTx(async (session) => {
    // One atomic step: the merchant must be online, verified, own a verified account and hold enough USDT.
    const merchant = await User.findOneAndUpdate(
      {
        _id: { $eq: merchantId, $ne: buyer._id },
        role: 'merchant',
        online: true,
        'kyc.status': 'verified',
        'paymentAccount.upi': { $type: 'string' },
        'balance.available': { $gte: usdtMinor }
      },
      { $inc: { 'balance.available': -usdtMinor, 'balance.escrow': usdtMinor } },
      { new: true, session }
    );
    if (!merchant) throw new HttpError(409, 'This merchant is offline or does not have enough USDT');

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const agg = await Order.aggregate([
      { $match: { merchant: merchant._id, createdAt: { $gte: startOfDay }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, total: { $sum: '$inrMinor' } } }
    ]).session(session);
    const used = agg[0] ? agg[0].total : 0;
    if (used + inrMinor > cfg.dailyLimitMinor) throw new HttpError(409, 'This merchant has reached the daily limit');

    const [o] = await Order.create(
      [{
        merchant: merchant._id,
        buyer: buyer._id,
        usdtMinor,
        rateMinor: cfg.rateMinor,
        inrMinor,
        payTo: { upi: merchant.paymentAccount.upi, holderName: merchant.paymentAccount.holderName },
        expectedPayerName: buyer.kyc.legalName,
        expiresAt: new Date(Date.now() + cfg.paymentWindowMs),
        history: [{ status: 'awaiting_payment', by: buyer._id, note: 'Order placed' }]
      }],
      { session }
    );
    await ledger(
      [{ user: merchant._id, order: o._id, type: 'escrow_lock', amountMinor: usdtMinor,
         availableAfter: merchant.balance.available, escrowAfter: merchant.balance.escrow }],
      session
    );
    await sys(o._id, `Order placed. ${usdt(usdtMinor)} for ${inr(inrMinor)}.`, session);
    return o;
  });

  rt.notify(String(order.merchant), 'order:new', { id: order.id, ref: order.ref });
  rt.orderUpdated(order);
  return order;
}

/** Buyer says the money has been sent. Allowed only inside the payment window. */
async function markPaid({ orderId, buyerId, utr }) {
  const order = await withTx(async (session) => {
    const o = await Order.findOneAndUpdate(
      { _id: orderId, buyer: buyerId, status: 'awaiting_payment', expiresAt: { $gt: new Date() } },
      {
        $set: { status: 'paid', paidAt: new Date(), utr },
        $push: { history: { status: 'paid', by: buyerId, note: 'Buyer marked payment as sent' } }
      },
      { new: true, session }
    );
    if (!o) throw new HttpError(409, 'This order is not waiting for payment, or its payment window has closed');
    await sys(o._id, `Buyer marked the payment as sent (reference ${utr}).`, session);
    return o;
  });
  rt.orderUpdated(order);
  rt.notify(String(order.merchant), 'order:paid', { id: order.id, ref: order.ref });
  return order;
}

/** Cancel an unpaid order. actorId = buyer or merchant. Pass expiredOnly for the timeout job. */
async function cancel({ orderId, actorId, expiredOnly = false, reason = 'Cancelled before payment' }) {
  const filter = { _id: orderId, status: 'awaiting_payment' };
  if (actorId) filter.$or = [{ buyer: actorId }, { merchant: actorId }];
  if (expiredOnly) filter.expiresAt = { $lte: new Date() };

  const order = await withTx(async (session) => {
    const o = await Order.findOneAndUpdate(
      filter,
      {
        $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
        $push: { history: { status: 'cancelled', by: actorId || undefined, note: reason } }
      },
      { new: true, session }
    );
    if (!o) throw new HttpError(409, 'This order can no longer be cancelled');
    await returnToMerchant(o, session);
    await sys(o._id, `Order cancelled. ${reason}. Escrow returned to the merchant.`, session);
    return o;
  });
  rt.orderUpdated(order);
  return order;
}

/** Merchant confirms the money is in their own account; escrow goes to the buyer. */
async function release({ orderId, merchantId }) {
  const order = await withTx(async (session) => {
    const o = await Order.findOneAndUpdate(
      { _id: orderId, merchant: merchantId, status: 'paid' },
      {
        $set: { status: 'completed', completedAt: new Date() },
        $push: { history: { status: 'completed', by: merchantId, note: 'Merchant confirmed the payment' } }
      },
      { new: true, session }
    );
    if (!o) throw new HttpError(409, 'This order is not waiting for your confirmation');
    await moveToBuyer(o, session);
    await sys(o._id, `Payment confirmed. Order ${inr(o.inrMinor)} released to the buyer.`, session);
    return o;
  });
  rt.orderUpdated(order);
  return order;
}

/** Cancels unpaid orders whose window has closed. Safe to run on every instance. */
async function expireOrders() {
  const due = await Order.find({ status: 'awaiting_payment', expiresAt: { $lte: new Date() } })
    .select('_id')
    .limit(100)
    .lean();
  let n = 0;
  for (const { _id } of due) {
    try {
      await cancel({ orderId: _id, actorId: null, expiredOnly: true, reason: 'Payment window closed' });
      n += 1;
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('expireOrders:', e.message);
    }
  }
  return n;
}

module.exports = { createOrder, markPaid, cancel, release, expireOrders, moveToBuyer, returnToMerchant };
