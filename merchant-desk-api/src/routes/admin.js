const router = require('express').Router();
const { z } = require('zod');
const User = require('../models/User');
const Order = require('../models/Order');
const Dispute = require('../models/Dispute');
const LedgerEntry = require('../models/LedgerEntry');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');
const { objectId, normalizeName } = require('../validators');
const { usdtToMinor } = require('../money');
const { withTx, ledger } = require('../services/common');
const { resolveDispute } = require('../services/disputes');
const orders = require('../services/orders');
const S = require('../serializers');
const realtime = require('../realtime');

router.use(requireAuth, requireRole('admin'));

/* ---- people and balances ---- */
router.get('/users', ah(async (req, res) => {
  const role = z.enum(['merchant', 'buyer']).optional().parse(req.query.role);
  const filter = { role: role || { $ne: 'admin' } };
  const rows = await User.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ users: rows.map((u) => S.user(u)) });
}));

/* ---- identity verification queue and approval history ---- */
router.get('/kyc', ah(async (req, res) => {
  const status = req.query.status || 'pending';
  let filter = { 'kyc.status': 'pending' };
  let sort = { 'kyc.submittedAt': 1 };

  if (status === 'history') {
    filter = { 'kyc.status': { $in: ['verified', 'rejected'] } };
    sort = { 'kyc.reviewedAt': -1 };
  } else if (status === 'verified') {
    filter = { 'kyc.status': 'verified' };
    sort = { 'kyc.reviewedAt': -1 };
  } else if (status === 'rejected') {
    filter = { 'kyc.status': 'rejected' };
    sort = { 'kyc.reviewedAt': -1 };
  } else if (status === 'all') {
    filter = { 'kyc.status': { $in: ['pending', 'verified', 'rejected'] } };
    sort = { updatedAt: -1 };
  }

  const [rows, pendingCount, historyCount] = await Promise.all([
    User.find(filter)
      .populate('kyc.reviewedBy', 'name email')
      .sort(sort)
      .limit(100),
    User.countDocuments({ 'kyc.status': 'pending' }),
    User.countDocuments({ 'kyc.status': { $in: ['verified', 'rejected'] } })
  ]);

  res.json({
    counts: { pending: pendingCount, history: historyCount },
    users: rows.map((u) => {
      const serialized = S.user(u);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        kyc: {
          ...serialized.kyc,
          submittedAt: u.kyc.submittedAt,
          reviewedAt: u.kyc.reviewedAt,
          reviewedBy: u.kyc.reviewedBy
            ? { id: u.kyc.reviewedBy._id, name: u.kyc.reviewedBy.name, email: u.kyc.reviewedBy.email }
            : null
        },
        submittedAt: u.kyc.submittedAt,
        reviewedAt: u.kyc.reviewedAt
      };
    })
  });
}));

router.post('/kyc/:userId', ah(async (req, res) => {
  objectId.parse(req.params.userId);
  const b = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(300).optional() }).parse(req.body);
  if (b.decision === 'reject' && !b.reason) throw new HttpError(400, 'Give a reason so the user can fix it');
  const u = await User.findOneAndUpdate(
    { _id: req.params.userId, 'kyc.status': 'pending' },
    {
      $set: {
        'kyc.status': b.decision === 'approve' ? 'verified' : 'rejected',
        'kyc.reviewedAt': new Date(),
        'kyc.reviewedBy': req.user._id,
        'kyc.rejectReason': b.decision === 'reject' ? b.reason : undefined
      }
    },
    { new: true }
  );
  if (!u) throw new HttpError(409, 'No pending verification for this user');
  res.json({ user: S.user(u) });
}));

/* ---- payment-account queue.
   The holder name on the UPI account must match the name verified in KYC. This is what keeps
   every merchant account tied to the real person behind it. ---- */
router.get('/payment-accounts', ah(async (req, res) => {
  const rows = await User.find({ 'pendingPaymentAccount.upi': { $type: 'string' } }).sort({ 'pendingPaymentAccount.submittedAt': 1 }).limit(100);
  res.json({ accounts: rows.map((u) => ({ userId: u.id, name: u.name, kycLegalName: u.kyc.legalName, upi: u.pendingPaymentAccount.upi, submittedAt: u.pendingPaymentAccount.submittedAt })) });
}));

router.post('/payment-accounts/:userId', ah(async (req, res) => {
  objectId.parse(req.params.userId);
  const b = z.object({
    decision: z.enum(['approve', 'reject']),
    holderName: z.string().trim().min(2).max(80).optional(), // name returned by the bank's name lookup
    reason: z.string().trim().max(300).optional()
  }).parse(req.body);

  const u = await User.findById(req.params.userId);
  if (!u || !u.pendingPaymentAccount || !u.pendingPaymentAccount.upi) throw new HttpError(409, 'No pending payment account for this user');

  if (b.decision === 'reject') {
    u.pendingPaymentAccount = undefined;
    await u.save();
    return res.json({ user: S.user(u) });
  }
  if (!b.holderName) throw new HttpError(400, 'Enter the account holder name returned by the bank lookup');
  if (u.kyc.status !== 'verified' || normalizeName(b.holderName) !== normalizeName(u.kyc.legalName)) {
    throw new HttpError(409, 'The account holder name does not match the verified identity');
  }
  u.paymentAccount = { upi: u.pendingPaymentAccount.upi, holderName: b.holderName.toUpperCase(), verifiedAt: new Date() };
  u.pendingPaymentAccount = undefined;
  await u.save(); // a duplicate UPI ID fails on the unique index and returns 409
  res.json({ user: S.user(u) });
}));

/* ---- disputes ---- */
router.post('/disputes/:id/resolve', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const b = z.object({
    outcome: z.enum(['release_to_buyer', 'return_to_merchant']),
    note: z.string().trim().min(5, 'Write a short note on why').max(1000)
  }).parse(req.body);
  const { dispute } = await resolveDispute({ disputeId: req.params.id, adminId: req.user._id, outcome: b.outcome, note: b.note });
  res.json({ dispute: S.dispute(dispute) });
}));

/* ---- development funding.
   Real deposits and withdrawals need an on-chain custody provider. Until one is connected, an admin
   credits balances by hand and every credit lands in the ledger. ---- */
router.post('/users/:id/credit', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const b = z.object({ usdt: z.number().positive().max(100000), note: z.string().trim().min(3).max(200) }).parse(req.body);
  const minor = usdtToMinor(b.usdt);
  const u = await withTx(async (session) => {
    const x = await User.findOneAndUpdate({ _id: req.params.id, role: { $ne: 'admin' } }, { $inc: { 'balance.available': minor } }, { new: true, session });
    if (!x) throw new HttpError(404, 'User not found');
    await ledger([{ user: x._id, type: 'admin_credit', amountMinor: minor, availableAfter: x.balance.available, escrowAfter: x.balance.escrow, note: `${b.note} (by ${req.user.email})` }], session);
    return x;
  });
  res.json({ user: S.user(u) });
}));

router.get('/users/:id/ledger', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const rows = await LedgerEntry.find({ user: req.params.id }).sort({ createdAt: -1 }).limit(100);
  res.json({ entries: rows.map((e) => ({ type: e.type, usdt: e.amountMinor / 100, availableAfter: e.availableAfter / 100, escrowAfter: e.escrowAfter / 100, order: e.order ? String(e.order) : null, note: e.note || null, at: e.createdAt })) });
}));

router.get('/disputes', ah(async (req, res) => {
  const status = z.enum(['review', 'resolved']).default('review').parse(req.query.status);
  const rows = await Dispute.find({ status }).sort({ createdAt: 1 }).limit(100);
  res.json({ disputes: rows.map(S.dispute) });
}));

/* ---- order monitoring ---- */
router.get('/orders', ah(async (req, res) => {
  const q = z.object({
    status: z.enum(['awaiting_payment', 'paid', 'completed', 'disputed', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    before: z.string().datetime().optional()
  }).parse(req.query);
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.before) filter.createdAt = { $lt: new Date(q.before) };
  const rows = await Order.find(filter)
    .populate('merchant', 'name')
    .populate('buyer', 'name')
    .sort({ createdAt: -1 })
    .limit(q.limit);
  res.json({ orders: rows.map((o) => S.order(o, req.user)) });
}));

/* ---- block / unblock accounts ----
   Blocked users get a 403 on every authenticated request. Their open orders continue but they
   cannot place new ones, go online, or sign in again once their current token expires. ---- */
router.post('/users/:id/block', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
  const u = await User.findOneAndUpdate(
    { _id: req.params.id, role: { $ne: 'admin' }, blocked: { $ne: true } },
    { $set: { blocked: true, blockedAt: new Date(), blockReason: b.reason } },
    { new: true }
  );
  if (!u) throw new HttpError(409, 'User not found or is already blocked');
  // Take the merchant offline immediately so no new orders land
  if (u.role === 'merchant' && u.online) {
    await User.updateOne({ _id: u._id }, { $set: { online: false } });
  }
  // Notify customer immediately in real-time
  realtime.notify(String(u._id), 'user:banned', {
    reason: b.reason,
    action: 'blocked'
  });
  res.json({ user: S.user(u) });
}));

router.post('/users/:id/unblock', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const u = await User.findOneAndUpdate(
    { _id: req.params.id, role: { $ne: 'admin' }, blocked: true },
    { $set: { blocked: false }, $unset: { blockedAt: 1, blockReason: 1 } },
    { new: true }
  );
  if (!u) throw new HttpError(409, 'User not found or is not blocked');
  res.json({ user: S.user(u) });
}));

/* ---- delete account after blocking ---- */
router.delete('/users/:id', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const u = await User.findOne({ _id: req.params.id, role: { $ne: 'admin' } });
  if (!u) throw new HttpError(404, 'User not found');
  if (!u.blocked) {
    throw new HttpError(400, 'User must be blocked before the account can be deleted');
  }

  // Guard: ensure no active in-flight trades (paid or disputed) involving this user
  const hasActiveOrders = await Order.exists({
    $or: [{ merchant: u._id }, { buyer: u._id }],
    status: { $in: ['paid', 'disputed'] }
  });
  if (hasActiveOrders) {
    throw new HttpError(409, 'Cannot delete user with in-progress paid or disputed orders. Settle or resolve them first.');
  }

  if (u.balance && u.balance.escrow > 0) {
    throw new HttpError(409, 'Cannot delete user with funds currently locked in escrow.');
  }

  const reason = u.blockReason || 'Account permanently banned and deleted by administrator';

  // Notify customer in real time so pop-up triggers before session termination
  realtime.notify(String(u._id), 'user:banned', {
    reason: reason,
    action: 'deleted'
  });

  // Cancel any open awaiting_payment orders properly to return merchant escrow
  const pendingOrders = await Order.find({
    $or: [{ merchant: u._id }, { buyer: u._id }],
    status: 'awaiting_payment'
  });
  for (const o of pendingOrders) {
    try {
      await orders.cancel({
        orderId: o._id,
        actorId: null,
        reason: 'Account banned and deleted by administration'
      });
    } catch (_) {}
  }

  await User.deleteOne({ _id: u._id });

  res.json({ ok: true, message: 'Account permanently deleted' });
}));

module.exports = router;
