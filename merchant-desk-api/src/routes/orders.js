const router = require('express').Router();
const { z } = require('zod');
const Order = require('../models/Order');
const User = require('../models/User');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');
const { objectId, usdtAmount, pageLimit } = require('../validators');
const { usdtToMinor, fromMinor } = require('../money');
const cfg = require('../config');
const orders = require('../services/orders');
const chat = require('../services/chat');
const rt = require('../realtime');
const S = require('../serializers');

router.use(requireAuth);

const populate = (q) => q.populate('merchant', 'name').populate('buyer', 'name');

/** Merchants a buyer can trade with right now. */
router.get('/merchants', requireRole('buyer'), ah(async (req, res) => {
  const { usdt } = z.object({ usdt: z.coerce.number().positive().optional() }).parse(req.query);
  const need = usdt ? usdtToMinor(usdt) : 1;
  const rows = await User.find({
    role: 'merchant', online: true, 'kyc.status': 'verified',
    'paymentAccount.upi': { $type: 'string' }, 'balance.available': { $gte: need }
  }).select('name balance.available').sort({ 'balance.available': -1 }).limit(30);
  res.json({
    rate: fromMinor(cfg.rateMinor),
    limits: { minInr: fromMinor(cfg.minOrderMinor), maxInr: fromMinor(cfg.maxOrderMinor) },
    merchants: rows.map((m) => ({ id: m.id, name: m.name, availableUsdt: fromMinor(m.balance.available) }))
  });
}));

router.post('/', requireRole('buyer'), ah(async (req, res) => {
  const b = z.object({ merchantId: objectId, usdt: usdtAmount }).parse(req.body);
  const o = await orders.createOrder({ buyer: req.user, merchantId: b.merchantId, usdtMinor: usdtToMinor(b.usdt) });
  const full = await populate(Order.findById(o._id));
  res.status(201).json({ order: S.order(full, req.user) });
}));

router.get('/', ah(async (req, res) => {
  const q = z.object({
    status: z.enum(['awaiting_payment', 'paid', 'completed', 'disputed', 'cancelled']).optional(),
    limit: pageLimit,
    before: z.string().datetime().optional()
  }).parse(req.query);
  const filter = {};
  if (req.user.role === 'merchant') filter.merchant = req.user._id;
  else if (req.user.role === 'buyer') filter.buyer = req.user._id;
  if (q.status) filter.status = q.status;
  if (q.before) filter.createdAt = { $lt: new Date(q.before) };
  const rows = await populate(Order.find(filter).sort({ createdAt: -1 }).limit(q.limit));
  res.json({ orders: rows.map((o) => S.order(o, req.user)) });
}));

/** Loads an order the caller is part of (admins can see all). */
async function mine(req) {
  objectId.parse(req.params.id);
  const o = await populate(Order.findById(req.params.id));
  if (!o) throw new HttpError(404, 'Order not found');
  const uid = String(req.user._id);
  const ok = req.user.role === 'admin' || String(o.merchant._id) === uid || String(o.buyer._id) === uid;
  if (!ok) throw new HttpError(404, 'Order not found');
  return o;
}

router.get('/:id', ah(async (req, res) => res.json({ order: S.order(await mine(req), req.user) })));

router.post('/:id/paid', requireRole('buyer'), ah(async (req, res) => {
  objectId.parse(req.params.id);
  const { utr } = z.object({ utr: z.string().trim().regex(/^[A-Za-z0-9]{6,22}$/, 'Enter the bank reference (6 to 22 letters or digits)') }).parse(req.body);
  await orders.markPaid({ orderId: req.params.id, buyerId: req.user._id, utr });
  res.json({ order: S.order(await mine(req), req.user) });
}));

router.post('/:id/cancel', requireRole('buyer', 'merchant'), ah(async (req, res) => {
  objectId.parse(req.params.id);
  await orders.cancel({
    orderId: req.params.id, actorId: req.user._id,
    reason: req.user.role === 'buyer' ? 'Cancelled by the buyer' : 'Cancelled by the merchant'
  });
  res.json({ order: S.order(await mine(req), req.user) });
}));

router.post('/:id/release', requireRole('merchant'), ah(async (req, res) => {
  objectId.parse(req.params.id);
  // The merchant must say they checked their own account before USDT moves.
  z.object({ statementChecked: z.literal(true, { errorMap: () => ({ message: 'Confirm that you checked your bank statement' }) }) }).parse(req.body);
  await orders.release({ orderId: req.params.id, merchantId: req.user._id });
  res.json({ order: S.order(await mine(req), req.user) });
}));

/* chat history (live messages go over Socket.io, REST send is the fallback) */
router.get('/:id/messages', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const q = z.object({ limit: pageLimit, before: z.string().datetime().optional() }).parse(req.query);
  res.json({ messages: await chat.listMessages({ orderId: req.params.id, user: req.user, before: q.before, limit: q.limit }) });
}));

router.post('/:id/messages', ah(async (req, res) => {
  objectId.parse(req.params.id);
  const { text } = z.object({ text: z.string() }).parse(req.body);
  const msg = await chat.sendMessage({ orderId: req.params.id, user: req.user, text });
  rt.emitMessage(msg);
  res.status(201).json({ message: msg });
}));

module.exports = router;
