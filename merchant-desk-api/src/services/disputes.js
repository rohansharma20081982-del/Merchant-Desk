const Order = require('../models/Order');
const Dispute = require('../models/Dispute');
const { HttpError } = require('../errors');
const { withTx, sys } = require('./common');
const { moveToBuyer, returnToMerchant } = require('./orders');
const rt = require('../realtime');

/** Buyer or merchant opens a dispute on an order the buyer has marked as paid. USDT stays in escrow. */
async function openDispute({ orderId, userId, reason, details, files }) {
  const { order, dispute } = await withTx(async (session) => {
    const o = await Order.findOneAndUpdate(
      { _id: orderId, status: 'paid', $or: [{ buyer: userId }, { merchant: userId }] },
      {
        $set: { status: 'disputed' },
        $push: { history: { status: 'disputed', by: userId, note: 'Dispute opened' } }
      },
      { new: true, session }
    );
    if (!o) throw new HttpError(409, 'Only an order that has been marked as paid can be disputed');
    const [d] = await Dispute.create([{ order: o._id, openedBy: userId, reason, details, files }], { session });
    await sys(o._id, `Dispute ${d.ref} opened. USDT stays in escrow until support decides.`, session);
    return { order: o, dispute: d };
  });
  rt.orderUpdated(order);
  return { order, dispute };
}

/** Support decision. Moves escrow to the buyer or back to the merchant, exactly once. */
async function resolveDispute({ disputeId, adminId, outcome, note }) {
  const { order, dispute } = await withTx(async (session) => {
    const d = await Dispute.findOneAndUpdate(
      { _id: disputeId, status: 'review' },
      { $set: { status: 'resolved', resolution: { outcome, note, by: adminId, at: new Date() } } },
      { new: true, session }
    );
    if (!d) throw new HttpError(409, 'This dispute does not exist or is already resolved');

    const toBuyer = outcome === 'release_to_buyer';
    const set = toBuyer
      ? { status: 'completed', completedAt: new Date() }
      : { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Dispute resolved in the merchant’s favour' };
    const o = await Order.findOneAndUpdate(
      { _id: d.order, status: 'disputed' },
      { $set: set, $push: { history: { status: set.status, by: adminId, note: `Dispute ${d.ref}: ${outcome}` } } },
      { new: true, session }
    );
    if (!o) throw new HttpError(409, 'The order is not in dispute');

    if (toBuyer) await moveToBuyer(o, session);
    else await returnToMerchant(o, session);
    await sys(o._id, `Dispute ${d.ref} resolved. USDT ${toBuyer ? 'released to the buyer' : 'returned to the merchant'}.`, session);
    return { order: o, dispute: d };
  });
  rt.orderUpdated(order);
  return { order, dispute };
}

module.exports = { openDispute, resolveDispute };
