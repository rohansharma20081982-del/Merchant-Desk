const router = require('express').Router();
const { z } = require('zod');
const User = require('../models/User');
const Dispute = require('../models/Dispute');
const LedgerEntry = require('../models/LedgerEntry');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');
const { objectId, normalizeName } = require('../validators');
const { usdtToMinor } = require('../money');
const { withTx, ledger } = require('../services/common');
const { resolveDispute } = require('../services/disputes');
const S = require('../serializers');

router.use(requireAuth, requireRole('admin'));

/* ---- people and balances ---- */
router.get('/users', ah(async (req, res) => {
  const role = z.enum(['merchant', 'buyer']).optional().parse(req.query.role);
  const filter = { role: role || { $ne: 'admin' } };
  const rows = await User.find(filter).sort({ createdAt: -1 }).limit(200);
  res.json({ users: rows.map((u) => S.user(u)) });
}));

/* ---- identity verification queue ---- */
router.get('/kyc', ah(async (req, res) => {
  const rows = await User.find({ 'kyc.status': 'pending' }).sort({ 'kyc.submittedAt': 1 }).limit(100);
  res.json({ users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, kyc: S.user(u).kyc, submittedAt: u.kyc.submittedAt, panLast4: u.kyc.panLast4 })) });
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

module.exports = router;
