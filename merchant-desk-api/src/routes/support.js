const router = require('express').Router();
const { z } = require('zod');
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const User = require('../models/User');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const { requireAuth, requireRole } = require('../middleware/auth');
const { objectId } = require('../validators');
const rt = require('../realtime');

router.use(requireAuth);

/* ========================================================
   Customer Endpoints (Single 1-to-1 Support Thread)
   ======================================================== */

/** Get the current customer's direct thread with support */
router.get('/thread', ah(async (req, res) => {
  let conv = await SupportConversation.findOne({ customer: req.user._id });
  if (!conv) {
    conv = await SupportConversation.create({
      customer: req.user._id,
      status: 'open',
      lastMessageText: '',
      lastMessageAt: new Date()
    });
  } else if (conv.unreadCustomerCount > 0) {
    conv.unreadCustomerCount = 0;
    await conv.save();
    await SupportMessage.updateMany(
      { conversation: conv._id, senderRole: 'admin', isRead: false },
      { $set: { isRead: true } }
    );
  }

  const messages = await SupportMessage.find({ conversation: conv._id }).sort({ createdAt: 1 }).limit(200);
  res.json({ conversation: conv, messages });
}));

/** Customer sends a message to Support */
router.post('/messages', ah(async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);

  let conv = await SupportConversation.findOne({ customer: req.user._id });
  if (!conv) {
    conv = await SupportConversation.create({
      customer: req.user._id,
      status: 'open',
      lastMessageText: text,
      lastMessageAt: new Date(),
      lastSenderRole: 'customer',
      unreadAdminCount: 1
    });
  } else {
    conv.status = 'open';
    conv.lastMessageText = text;
    conv.lastMessageAt = new Date();
    conv.lastSenderRole = 'customer';
    conv.unreadAdminCount = (conv.unreadAdminCount || 0) + 1;
    await conv.save();
  }

  const msg = await SupportMessage.create({
    conversation: conv._id,
    sender: req.user._id,
    senderRole: 'customer',
    senderName: req.user.name,
    text
  });

  rt.emitSupportMessage(msg, conv);

  res.status(201).json({ message: msg, conversation: conv });
}));

/** Quick check for customer unread support messages */
router.get('/unread-count', ah(async (req, res) => {
  const conv = await SupportConversation.findOne({ customer: req.user._id });
  res.json({ unread: conv ? (conv.unreadCustomerCount || 0) : 0 });
}));

/* ========================================================
   Admin Endpoints (WhatsApp Web-Style Inbox)
   ======================================================== */

/** Admin Support Inbox: list of all customer conversations */
router.get('/admin/inbox', requireRole('admin'), ah(async (req, res) => {
  const { status, q } = req.query;
  const filter = {};
  if (status && status !== 'all') {
    filter.status = status;
  }

  let rows = await SupportConversation.find(filter)
    .populate('customer', 'name email role kyc')
    .sort({ lastMessageAt: -1 })
    .limit(100);

  if (q && q.trim()) {
    const term = q.trim().toLowerCase();
    rows = rows.filter((c) => {
      const u = c.customer;
      if (!u) return false;
      return (u.name && u.name.toLowerCase().includes(term)) || (u.email && u.email.toLowerCase().includes(term));
    });
  }

  const allOpen = await SupportConversation.find({ unreadAdminCount: { $gt: 0 } });
  const totalUnread = allOpen.reduce((sum, c) => sum + (c.unreadAdminCount || 0), 0);

  res.json({
    conversations: rows.map((c) => ({
      id: c.id,
      customer: c.customer ? {
        id: c.customer.id,
        name: c.customer.name,
        email: c.customer.email,
        role: c.customer.role,
        kycStatus: c.customer.kyc && c.customer.kyc.status
      } : { id: 'unknown', name: 'Deleted User', email: '' },
      status: c.status,
      lastMessageText: c.lastMessageText,
      lastMessageAt: c.lastMessageAt,
      lastSenderRole: c.lastSenderRole,
      unreadAdminCount: c.unreadAdminCount || 0,
      unreadCustomerCount: c.unreadCustomerCount || 0,
      createdAt: c.createdAt
    })),
    totalUnread
  });
}));

/** Admin gets full conversation with a customer */
router.get('/admin/conversations/:id', requireRole('admin'), ah(async (req, res) => {
  objectId.parse(req.params.id);
  const conv = await SupportConversation.findById(req.params.id).populate('customer', 'name email role kyc');
  if (!conv) throw new HttpError(404, 'Conversation not found');

  if (conv.unreadAdminCount > 0) {
    conv.unreadAdminCount = 0;
    await conv.save();
    await SupportMessage.updateMany(
      { conversation: conv._id, senderRole: 'customer', isRead: false },
      { $set: { isRead: true } }
    );
    rt.emitSupportInboxUpdate();
  }

  const messages = await SupportMessage.find({ conversation: conv._id }).sort({ createdAt: 1 }).limit(300);

  res.json({
    conversation: {
      id: conv.id,
      customer: conv.customer ? {
        id: conv.customer.id,
        name: conv.customer.name,
        email: conv.customer.email,
        role: conv.customer.role,
        kycStatus: conv.customer.kyc && conv.customer.kyc.status
      } : { id: 'unknown', name: 'Deleted User', email: '' },
      status: conv.status,
      lastMessageText: conv.lastMessageText,
      lastMessageAt: conv.lastMessageAt,
      lastSenderRole: conv.lastSenderRole,
      createdAt: conv.createdAt
    },
    messages
  });
}));

/** Admin replies to a customer conversation */
router.post('/admin/conversations/:id/reply', requireRole('admin'), ah(async (req, res) => {
  objectId.parse(req.params.id);
  const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);

  const conv = await SupportConversation.findById(req.params.id);
  if (!conv) throw new HttpError(404, 'Conversation not found');

  conv.lastMessageText = text;
  conv.lastMessageAt = new Date();
  conv.lastSenderRole = 'admin';
  conv.unreadCustomerCount = (conv.unreadCustomerCount || 0) + 1;
  await conv.save();

  const msg = await SupportMessage.create({
    conversation: conv._id,
    sender: req.user._id,
    senderRole: 'admin',
    senderName: 'Support',
    text
  });

  rt.emitSupportMessage(msg, conv);

  res.status(201).json({ message: msg });
}));

/** Admin updates conversation status (open / resolved) */
router.post('/admin/conversations/:id/status', requireRole('admin'), ah(async (req, res) => {
  objectId.parse(req.params.id);
  const { status } = z.object({ status: z.enum(['open', 'resolved']) }).parse(req.body);

  const conv = await SupportConversation.findByIdAndUpdate(
    req.params.id,
    { $set: { status } },
    { new: true }
  );
  if (!conv) throw new HttpError(404, 'Conversation not found');

  rt.emitSupportInboxUpdate();

  res.json({ conversation: conv });
}));

module.exports = router;
