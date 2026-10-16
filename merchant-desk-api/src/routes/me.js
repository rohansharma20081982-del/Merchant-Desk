const router = require('express').Router();
const { z } = require('zod');
const User = require('../models/User');
const Order = require('../models/Order');
const Dispute = require('../models/Dispute');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upiId } = require('../validators');
const { fromMinor } = require('../money');
const S = require('../serializers');

router.use(requireAuth);

router.get('/', (req, res) => res.json({ user: S.user(req.user) }));

/* Identity verification. Legal name and last 4 chars of PAN are stored.
   An admin (or a KYC provider you plug in) approves it. */
const kycSchema = z.object({
  legalName: z.string().trim().min(3).max(80),
  panLast4: z.string().trim().length(4).regex(/^[A-Z0-9]{4}$/i, 'Enter the last 4 characters of your PAN').optional()
});

router.post('/kyc', ah(async (req, res) => {
  const b = kycSchema.parse(req.body);
  const u = req.user;
  if (u.role === 'admin') throw new HttpError(403, 'Not available for admins');
  if (u.kyc.status === 'pending') throw new HttpError(409, 'Your verification is already in review');
  if (u.kyc.status === 'verified') throw new HttpError(409, 'You are already verified');
  u.kyc = { status: 'pending', legalName: b.legalName, panLast4: b.panLast4 ? b.panLast4.toUpperCase() : undefined, submittedAt: new Date() };
  await u.save();
  res.json({ user: S.user(u) });
}));

/* One payment account per merchant. A change goes into review and takes the merchant offline until approved. */
router.put('/payment-account', requireRole('merchant'), ah(async (req, res) => {
  const { upi } = z.object({ upi: upiId }).parse(req.body);
  const u = req.user;
  if (u.kyc.status !== 'verified') throw new HttpError(403, 'Complete identity verification first');
  if (u.paymentAccount && u.paymentAccount.upi === upi) throw new HttpError(409, 'This is already your payment account');
  const taken = await User.exists({
    _id: { $ne: u._id },
    $or: [{ 'paymentAccount.upi': upi }, { 'pendingPaymentAccount.upi': upi }]
  });
  if (taken) throw new HttpError(409, 'This UPI ID is already registered to another account');
  u.pendingPaymentAccount = { upi, submittedAt: new Date() };
  u.online = false;
  await u.save();
  res.json({ user: S.user(u) });
}));

router.post('/online', requireRole('merchant'), ah(async (req, res) => {
  const { online } = z.object({ online: z.boolean() }).parse(req.body);
  const u = req.user;
  if (online) {
    if (u.kyc.status !== 'verified') throw new HttpError(403, 'Complete identity verification first');
    if (!u.paymentAccount || !u.paymentAccount.upi) throw new HttpError(403, 'Add and verify your payment account first');
    if (u.pendingPaymentAccount && u.pendingPaymentAccount.upi) {
      throw new HttpError(403, 'Your new payment account is still being verified');
    }
  }
  u.online = online;
  await u.save();
  res.json({ user: S.user(u) });
}));

router.get('/stats', requireRole('merchant'), ah(async (req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [today] = await Order.aggregate([
    { $match: { merchant: req.user._id, status: 'completed', completedAt: { $gte: start } } },
    { $group: { _id: null, count: { $sum: 1 }, inr: { $sum: '$inrMinor' } } }
  ]);
  const closed = await Order.aggregate([
    { $match: { merchant: req.user._id, status: { $in: ['completed', 'cancelled', 'disputed'] } } },
    { $group: { _id: '$status', n: { $sum: 1 } } }
  ]);
  const n = Object.fromEntries(closed.map((c) => [c._id, c.n]));
  const total = (n.completed || 0) + (n.cancelled || 0) + (n.disputed || 0);
  const myOrderIds = await Order.find({ merchant: req.user._id, status: 'disputed' }).distinct('_id');
  const openDisputes = await Dispute.countDocuments({ order: { $in: myOrderIds }, status: 'review' });
  res.json({
    balance: S.user(req.user).balance,
    today: { completed: today ? today.count : 0, volumeInr: today ? fromMinor(today.inr) : 0 },
    completionRate: total ? Math.round((100 * (n.completed || 0)) / total) : 100,
    openDisputes
  });
}));

/* Customer transaction & transition history */
router.get('/transactions', ah(async (req, res) => {
  const LedgerEntry = require('../models/LedgerEntry');
  const entries = await LedgerEntry.find({ user: req.user._id })
    .populate({
      path: 'order',
      select: 'ref status inrMinor usdtMinor payTo buyer merchant createdAt completedAt cancelledAt',
      populate: [
        { path: 'buyer', select: 'name' },
        { path: 'merchant', select: 'name' }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(150);

  const transactions = entries.map((e) => {
    const o = e.order;
    let title = 'Balance adjustment';
    let direction = 'in'; // 'in' = credit, 'out' = debit, 'neutral'
    let orderRef = o ? o.ref : null;
    let orderId = o ? o._id : null;
    let counterparty = null;

    if (o) {
      const isBuyer = String(o.buyer && (o.buyer._id || o.buyer)) === String(req.user._id);
      counterparty = isBuyer ? (o.merchant && o.merchant.name) : (o.buyer && o.buyer.name);
    }

    switch (e.type) {
      case 'received_from_escrow':
        title = orderRef ? `Received from Escrow (#${orderRef})` : 'Received from Escrow';
        direction = 'in';
        break;
      case 'escrow_lock':
        title = orderRef ? `Escrow Locked for Order (#${orderRef})` : 'Escrow Locked';
        direction = 'out';
        break;
      case 'escrow_release':
        title = orderRef ? `Escrow Released to Buyer (#${orderRef})` : 'Escrow Released';
        direction = 'out';
        break;
      case 'escrow_return':
        title = orderRef ? `Escrow Refunded / Returned (#${orderRef})` : 'Escrow Returned';
        direction = 'in';
        break;
      case 'admin_credit':
        title = e.note || 'Wallet Balance Added by Admin';
        direction = 'in';
        break;
      default:
        title = e.note || e.type;
        direction = 'neutral';
    }

    return {
      id: e.id,
      type: e.type,
      title,
      direction,
      amount: fromMinor(e.amountMinor),
      amountMinor: e.amountMinor,
      availableAfter: fromMinor(e.availableAfter != null ? e.availableAfter : req.user.balance.available),
      escrowAfter: fromMinor(e.escrowAfter != null ? e.escrowAfter : req.user.balance.escrow),
      orderRef,
      orderId,
      counterparty,
      orderStatus: o ? o.status : null,
      note: e.note || null,
      createdAt: e.createdAt
    };
  });

  const totalIn = transactions.filter((t) => t.direction === 'in').reduce((acc, t) => acc + t.amount, 0);
  const totalOut = transactions.filter((t) => t.direction === 'out').reduce((acc, t) => acc + t.amount, 0);

  res.json({
    summary: {
      available: fromMinor(req.user.balance.available),
      escrow: fromMinor(req.user.balance.escrow),
      totalIn,
      totalOut,
      count: transactions.length
    },
    transactions
  });
}));

module.exports = router;
