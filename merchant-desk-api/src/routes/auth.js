const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const cfg = require('../config');
const User = require('../models/User');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const S = require('../serializers');

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
  role: z.enum(['merchant', 'buyer']) // admins are created with `npm run seed:admin`, never over the API
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

const sign = (u) => jwt.sign({ sub: u.id, role: u.role }, cfg.jwtSecret, { expiresIn: cfg.jwtTtl });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

router.post('/register', ah(async (req, res) => {
  const b = registerSchema.parse(req.body);
  if (await User.exists({ email: b.email })) throw new HttpError(409, 'An account with this email already exists');
  const user = await User.create({
    name: b.name,
    email: b.email,
    role: b.role,
    passwordHash: await bcrypt.hash(b.password, 12)
  });
  res.status(201).json({ token: sign(user), user: S.user(user) });
}));

router.post('/login', ah(async (req, res) => {
  const b = loginSchema.parse(req.body);
  const user = await User.findOne({ email: b.email }).select('+passwordHash');
  const ok = await bcrypt.compare(b.password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Email or password is incorrect');
  res.json({ token: sign(user), user: S.user(user) });
}));

module.exports = router;
