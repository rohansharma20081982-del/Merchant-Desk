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

/* Identity verification. Only the legal name and the last 4 PAN characters are stored.
   An admin (or a KYC provider you plug in) approves it. */
const kycSchema = z.object({
  legalName: z.string().trim().min(3).max(80),
  panLast4: z.string().regex(/^[A-Za-z0-9]{4}$/, 'Enter the last 4 characters of your PAN')
});

router.post('/kyc', ah(async (req, res) => {
  const b = kycSchema.parse(req.body);
  const u = req.user;
  if (u.role === 'admin') throw new HttpError(403, 'Not available for admins');
  if (u.kyc.status === 'pending') throw new HttpError(409, 'Your verification is already in review');
  if (u.kyc.status === 'verified') throw new HttpError(409, 'You are already verified');
  u.kyc = { status: 'pending', legalName: b.legalName, panLast4: b.panLast4.toUpperCase(), submittedAt: new Date() };
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

module.exports = router;
