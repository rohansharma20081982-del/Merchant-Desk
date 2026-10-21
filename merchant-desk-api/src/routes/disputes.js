const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = require('express').Router();
const multer = require('multer');
const { z } = require('zod');
const cfg = require('../config');
const Dispute = require('../models/Dispute');
const Order = require('../models/Order');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const { requireAuth } = require('../middleware/auth');
const { objectId } = require('../validators');
const { REASONS } = require('../models/Dispute');
const disputes = require('../services/disputes');
const S = require('../serializers');

router.use(requireAuth);

/* ---- proof uploads: images and PDFs only, 5 MB each, named <userId>-<random>.<ext> ---- */
const os = require('os');
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NODE_ENV === 'production');
const UPLOAD_DIR = isServerless ? path.join(os.tmpdir(), 'uploads') : path.resolve(cfg.uploadDir || 'uploads');
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (_) {}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${req.user.id}-${crypto.randomBytes(8).toString('hex')}.${EXT[file.mimetype]}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => (EXT[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Upload a JPG, PNG, WebP or PDF file')))
});

router.post('/uploads', upload.array('files', 5), (req, res) => {
  res.status(201).json({ files: (req.files || []).map((f) => ({ name: f.filename, originalName: path.basename(f.originalname).slice(0, 120) })) });
});

/* ---- disputes ---- */
const createSchema = z.object({
  orderId: objectId,
  reason: z.enum(REASONS),
  details: z.string().trim().min(10, 'Describe what happened in a sentence or two').max(2000),
  files: z.array(z.object({ name: z.string().regex(/^[a-f\d]{24}-[a-f\d]{16}\.(jpg|png|webp|pdf)$/), originalName: z.string().max(120) })).max(5).default([])
});

router.post('/', ah(async (req, res) => {
  const b = createSchema.parse(req.body);
  // A file can only be attached by the user who uploaded it.
  for (const f of b.files) {
    if (!f.name.startsWith(req.user.id + '-')) throw new HttpError(400, 'One of the files was not uploaded by you');
    if (!fs.existsSync(path.join(UPLOAD_DIR, f.name))) throw new HttpError(400, 'One of the files could not be found. Upload it again');
  }
  const { dispute } = await disputes.openDispute({
    orderId: b.orderId, userId: req.user._id, reason: b.reason, details: b.details, files: b.files
  });
  res.status(201).json({ dispute: S.dispute(dispute) });
}));

async function visibleOrderIds(user) {
  if (user.role === 'admin') return null;
  const key = user.role === 'merchant' ? 'merchant' : 'buyer';
  return Order.find({ [key]: user._id }).distinct('_id');
}

router.get('/', ah(async (req, res) => {
  const status = z.enum(['review', 'resolved']).optional().parse(req.query.status);
  const ids = await visibleOrderIds(req.user);
  const filter = ids ? { order: { $in: ids } } : {};
  if (status) filter.status = status;
  const rows = await Dispute.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ disputes: rows.map(S.dispute) });
}));

async function load(req) {
  objectId.parse(req.params.id);
  const d = await Dispute.findById(req.params.id);
  if (!d) throw new HttpError(404, 'Dispute not found');
  if (req.user.role !== 'admin') {
    const ok = await Order.exists({ _id: d.order, $or: [{ merchant: req.user._id }, { buyer: req.user._id }] });
    if (!ok) throw new HttpError(404, 'Dispute not found');
  }
  return d;
}

router.get('/:id', ah(async (req, res) => res.json({ dispute: S.dispute(await load(req)) })));

router.get('/:id/files/:name', ah(async (req, res) => {
  const d = await load(req);
  const f = d.files.find((x) => x.name === req.params.name);
  if (!f) throw new HttpError(404, 'File not found');
  res.set('Content-Disposition', `inline; filename="${f.originalName.replace(/[^\w.\- ]/g, '_')}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(UPLOAD_DIR, f.name));
}));

module.exports = router;
