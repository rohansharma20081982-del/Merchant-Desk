const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const cfg = require('../config');
const User = require('../models/User');
const { HttpError } = require('../errors');
const { ah } = require('../middleware/error');
const S = require('../serializers');
const OtpService = require('../services/OtpService');
const {
  otpSendSchema,
  otpVerifySchema,
  phoneLoginRequestSchema,
  phoneLoginVerifySchema
} = require('../validators');
const { verifyGoogleToken } = require('../services/googleAuth');
const rateLimit = require('express-rate-limit');

const isTest = process.env.NODE_ENV === 'test';
const loginBruteLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' }
});

const otpSendRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1000 : 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification code requests. Please try again later.' }
});

const otpVerifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 1000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' }
});

// Optional authentication middleware for endpoints that can benefit from logged-in user context
async function optionalAuth(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Bearer' && token) {
      const payload = jwt.verify(token, cfg.jwtSecret);
      const user = await User.findById(payload.sub);
      if (user && !user.blocked) {
        req.user = user;
      }
    }
  } catch (_) {
    // Ignore invalid/expired tokens for optional auth
  }
  next();
}

router.use(optionalAuth);

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
  phone: z.string().trim().optional(),
  role: z.enum(['merchant', 'buyer']) // admins are created with `npm run seed:admin`, never over the API
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128)
});

const googleAuthSchema = z.object({
  credential: z.string().min(10, 'Google credential token is required').optional(),
  email: z.string().trim().toLowerCase().email('Please enter a valid Gmail address').optional(),
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(['merchant', 'buyer']).optional()
}).refine((data) => data.credential || data.email, {
  message: 'Google credential token or Gmail address is required',
  path: ['credential']
});

const sign = (u) => jwt.sign({ sub: u.id, role: u.role }, cfg.jwtSecret, { expiresIn: cfg.jwtTtl });
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

router.post('/register', ah(async (req, res) => {
  const b = registerSchema.parse(req.body);
  if (await User.exists({ email: b.email })) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  let normalizedPhone = null;
  if (b.phone) {
    normalizedPhone = OtpService.normalizePhoneNumber(b.phone);
    if (await User.exists({ phone: normalizedPhone })) {
      throw new HttpError(409, 'An account with this phone number already exists');
    }
  }

  const user = await User.create({
    name: b.name,
    email: b.email,
    phone: normalizedPhone,
    phoneVerified: false,
    role: b.role,
    passwordHash: await bcrypt.hash(b.password, 12),
    authProvider: 'local',
    emailVerified: false
  });

  const requiresVerification = {
    phone: cfg.requirePhoneVerification && !user.phoneVerified,
    email: cfg.requireEmailVerification && !user.emailVerified
  };

  res.status(201).json({
    token: sign(user),
    user: S.user(user),
    requiresVerification
  });
}));

router.post('/login', loginBruteLimit, ah(async (req, res) => {
  const b = loginSchema.parse(req.body);
  const user = await User.findOne({ email: b.email }).select('+passwordHash');
  const hash = user && user.passwordHash ? user.passwordHash : DUMMY_HASH;
  const ok = await bcrypt.compare(b.password, hash);
  if (!user || !user.passwordHash || !ok) throw new HttpError(401, 'Email or password is incorrect');
  if (user.blocked) {
    const err = new HttpError(403, `Your account has been banned: ${user.blockReason || 'Terms violation'}`);
    err.banned = true;
    err.reason = user.blockReason || 'Terms violation';
    throw err;
  }
  res.json({ token: sign(user), user: S.user(user) });
}));

router.post('/google', ah(async (req, res) => {
  const b = googleAuthSchema.parse(req.body);
  let verified;
  if (b.credential) {
    verified = await verifyGoogleToken(b.credential);
  } else if (b.email) {
    const emailNorm = b.email.toLowerCase().trim();
    verified = {
      googleId: 'gmail_' + Buffer.from(emailNorm).toString('base64url'),
      email: emailNorm,
      name: b.name || emailNorm.split('@')[0],
      picture: null,
      emailVerified: true
    };
  }

  let user = await User.findOne({
    $or: [{ googleId: verified.googleId }, { email: verified.email }]
  });

  if (user) {
    if (user.blocked) {
      const err = new HttpError(403, `Your account has been banned: ${user.blockReason || 'Terms violation'}`);
      err.banned = true;
      err.reason = user.blockReason || 'Terms violation';
      throw err;
    }
    let modified = false;
    if (!user.googleId) {
      user.googleId = verified.googleId;
      modified = true;
    }
    if (!user.emailVerified) {
      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      modified = true;
    }
    if (modified) {
      await user.save();
    }
    return res.json({ token: sign(user), user: S.user(user), isNewUser: false });
  }

  user = await User.create({
    name: verified.name,
    email: verified.email,
    role: b.role || 'buyer',
    authProvider: 'google',
    googleId: verified.googleId,
    emailVerified: true,
    emailVerifiedAt: new Date()
  });

  res.status(201).json({ token: sign(user), user: S.user(user), isNewUser: true });
}));

router.post('/gmail', (req, res, next) => {
  req.url = '/google';
  router.handle(req, res, next);
});

/* ---------- OTP Endpoints ---------- */

/**
 * POST /auth/otp/send
 * Body: { channel: 'sms'|'email', destination: string, purpose: 'signup'|'login'|'verify_contact'|'password_reset' }
 */
router.post('/otp/send', otpSendRateLimit, ah(async (req, res) => {
  const b = otpSendSchema.parse(req.body);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  const result = await OtpService.sendOtp({
    channel: b.channel,
    destination: b.destination,
    purpose: b.purpose,
    user: req.user || null,
    ip: String(clientIp)
  });

  res.json({
    ok: true,
    message: 'Verification code sent',
    channel: b.channel,
    destinationMasked: result.destinationMasked,
    cooldownSeconds: result.cooldownSeconds,
    expiresInSeconds: result.expiresInSeconds
  });
}));

/**
 * POST /auth/otp/verify
 * Body: { channel: 'sms'|'email', destination: string, purpose: '...', otp: '123456' }
 * If user is authenticated, marks matching contact as verified.
 */
router.post('/otp/verify', otpVerifyRateLimit, ah(async (req, res) => {
  const b = otpVerifySchema.parse(req.body);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  await OtpService.verifyOtp({
    channel: b.channel,
    destination: b.destination,
    purpose: b.purpose,
    otp: b.otp,
    user: req.user || null,
    ip: String(clientIp)
  });

  res.json({
    ok: true,
    verified: true,
    message: 'Verification successful',
    user: req.user ? S.user(req.user) : undefined
  });
}));

/* ---------- Phone Login Endpoints ---------- */

/**
 * POST /auth/login/phone/request
 * Body: { phone: string }
 * Generic response prevents account enumeration. Only sends OTP if number exists and is verified.
 */
router.post('/login/phone/request', otpSendRateLimit, ah(async (req, res) => {
  const b = phoneLoginRequestSchema.parse(req.body);
  const normalizedPhone = OtpService.normalizePhoneNumber(b.phone);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  const user = await User.findOne({ phone: normalizedPhone });

  // Generic response helper
  const genericResponse = () => res.json({
    ok: true,
    message: 'If this phone number is registered and verified, a verification code has been sent.',
    destinationMasked: OtpService.maskDestination(normalizedPhone),
    cooldownSeconds: cfg.otpCooldownSeconds
  });

  // Account enumeration defense:
  // If user does not exist or phone is not verified, do not send OTP, return generic message.
  if (!user || !user.phoneVerified) {
    await OtpService.logAudit({
      event: 'phone_login_request',
      channel: 'sms',
      destination: normalizedPhone,
      purpose: 'login',
      ip: String(clientIp),
      success: false,
      reason: !user ? 'User not found (no enumeration)' : 'Phone not verified'
    });
    return genericResponse();
  }

  // Check if banned
  if (user.blocked) {
    const err = new HttpError(403, `Your account has been banned: ${user.blockReason || 'Terms violation'}`);
    err.banned = true;
    err.reason = user.blockReason || 'Terms violation';
    throw err;
  }

  // Dispatch OTP
  await OtpService.sendOtp({
    channel: 'sms',
    destination: normalizedPhone,
    purpose: 'login',
    user,
    ip: String(clientIp)
  });

  await OtpService.logAudit({
    event: 'phone_login_request',
    channel: 'sms',
    destination: normalizedPhone,
    purpose: 'login',
    user,
    ip: String(clientIp),
    success: true
  });

  return genericResponse();
}));

/**
 * POST /auth/login/phone/verify
 * Body: { phone: string, otp: '123456' }
 * Logs the user in with token and user object, identical to password login.
 */
router.post('/login/phone/verify', otpVerifyRateLimit, ah(async (req, res) => {
  const b = phoneLoginVerifySchema.parse(req.body);
  const normalizedPhone = OtpService.normalizePhoneNumber(b.phone);
  const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  const user = await User.findOne({ phone: normalizedPhone });
  if (!user || !user.phoneVerified) {
    // Constant time / generic error message
    throw new HttpError(401, 'Invalid phone number or verification code');
  }

  if (user.blocked) {
    const err = new HttpError(403, `Your account has been banned: ${user.blockReason || 'Terms violation'}`);
    err.banned = true;
    err.reason = user.blockReason || 'Terms violation';
    throw err;
  }

  try {
    await OtpService.verifyOtp({
      channel: 'sms',
      destination: normalizedPhone,
      purpose: 'login',
      otp: b.otp,
      user,
      ip: String(clientIp)
    });
  } catch (err) {
    await OtpService.logAudit({
      event: 'phone_login_failure',
      channel: 'sms',
      destination: normalizedPhone,
      purpose: 'login',
      user,
      ip: String(clientIp),
      success: false,
      reason: err.message
    });
    throw err;
  }

  await OtpService.logAudit({
    event: 'phone_login_success',
    channel: 'sms',
    destination: normalizedPhone,
    purpose: 'login',
    user,
    ip: String(clientIp),
    success: true
  });

  res.json({ token: sign(user), user: S.user(user) });
}));

module.exports = router;
