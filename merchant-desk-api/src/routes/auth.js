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
  otpVerifySchema
} = require('../validators');
const crypto = require('node:crypto');
const { getEmailProvider } = require('../services/email');
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

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const userFields = {
    name: b.name,
    email: b.email,
    role: b.role,
    passwordHash: await bcrypt.hash(b.password, 12),
    authProvider: 'local',
    emailVerified: false,
    emailVerifyToken: tokenHash,
    emailVerifyExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  };
  if (normalizedPhone) {
    userFields.phone = normalizedPhone;
    userFields.phoneVerified = false;
  }

  const user = await User.create(userFields);

  const appBase = req.headers.origin || `http://localhost:${cfg.port || 4000}`;
  const verifyUrl = `${appBase}/#verify_email=${rawToken}`;

  const emailHtml = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;color:#0f172a">
      <div style="font-size:24px;font-weight:700;color:#0f172a;margin-bottom:12px">₹ Merchant Desk</div>
      <h2 style="font-size:20px;margin:0 0 12px;color:#0f172a">Verify your email address</h2>
      <p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 20px">
        Hello <b>${user.name}</b>,<br>
        Thank you for creating an account on Merchant Desk. Please click the button below to verify your email address and activate your trading desk.
      </p>
      <div style="text-align:center;margin:28px 0">
        <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;border-radius:8px">Click to Verify Email</a>
      </div>
      <p style="font-size:13px;color:#94a3b8;line-height:1.5;margin:20px 0 0">
        Or copy and paste this link into your browser:<br>
        <a href="${verifyUrl}" style="color:#059669;word-break:break-all">${verifyUrl}</a>
      </p>
    </div>
  `;

  try {
    await getEmailProvider().sendEmail({
      to: user.email,
      subject: 'Verify your Merchant Desk account',
      html: emailHtml,
      text: `Hello ${user.name},\n\nPlease click the link below to verify your email address:\n${verifyUrl}\n\nValid for 24 hours.`
    });
  } catch (err) {
    console.warn('Failed to send verification email:', err.message);
  }

  res.status(201).json({
    token: sign(user),
    user: S.user(user),
    requiresVerification: { email: true },
    verificationSentTo: user.email,
    verifyUrl: process.env.NODE_ENV !== 'production' ? verifyUrl : undefined
  });
}));

const verifyEmailSchema = z.object({
  token: z.string().trim().min(10, 'Verification token is required')
});

router.post('/verify-email', ah(async (req, res) => {
  const b = verifyEmailSchema.parse(req.body);
  const tokenHash = crypto.createHash('sha256').update(b.token).digest('hex');

  const user = await User.findOne({
    emailVerifyToken: tokenHash,
    emailVerifyExpiresAt: { $gt: new Date() }
  });

  if (!user) {
    throw new HttpError(400, 'Invalid or expired email verification link');
  }

  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  user.emailVerifyToken = undefined;
  user.emailVerifyExpiresAt = undefined;
  await user.save();

  res.json({
    ok: true,
    verified: true,
    message: 'Email address verified successfully',
    token: sign(user),
    user: S.user(user)
  });
}));

router.get('/verify-email', ah(async (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/#error=missing_token');
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const user = await User.findOne({
    emailVerifyToken: tokenHash,
    emailVerifyExpiresAt: { $gt: new Date() }
  });
  if (!user) {
    return res.redirect('/#error=invalid_verification_token');
  }
  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  user.emailVerifyToken = undefined;
  user.emailVerifyExpiresAt = undefined;
  await user.save();
  return res.redirect(`/#verified=true&token=${sign(user)}`);
}));

router.post('/resend-verification', ah(async (req, res) => {
  const email = (req.body.email || (req.user && req.user.email) || '').trim().toLowerCase();
  if (!email) throw new HttpError(400, 'Email address is required');
  const user = await User.findOne({ email });
  if (!user) {
    return res.json({ ok: true, message: 'If this email exists, a verification link has been sent.' });
  }
  if (user.emailVerified) {
    return res.json({ ok: true, message: 'This email is already verified.' });
  }
  const rawToken = crypto.randomBytes(32).toString('hex');
  user.emailVerifyToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  user.emailVerifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await user.save();

  const appBase = req.headers.origin || `http://localhost:${cfg.port || 4000}`;
  const verifyUrl = `${appBase}/#verify_email=${rawToken}`;
  await getEmailProvider().sendEmail({
    to: user.email,
    subject: 'Verify your Merchant Desk account',
    html: `Click here to verify your email address: <a href="${verifyUrl}">Verify Email</a>`,
    text: `Verify your email address: ${verifyUrl}`
  });

  res.json({
    ok: true,
    message: 'Verification link resent',
    verifyUrl: process.env.NODE_ENV !== 'production' ? verifyUrl : undefined
  });
}));

router.post('/login', loginBruteLimit, ah(async (req, res) => {
  const b = loginSchema.parse(req.body);
  let user = await User.findOne({ email: b.email }).select('+passwordHash');

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || '';

  // Auto-provision or sync admin account when logging in with configured admin credentials
  if (adminEmail && adminPassword && b.email === adminEmail && b.password === adminPassword) {
    if (!user) {
      user = await User.create({
        name: 'Support Admin',
        email: adminEmail,
        role: 'admin',
        passwordHash: await bcrypt.hash(adminPassword, 12),
        emailVerified: true
      });
    } else {
      let needsSave = false;
      if (user.role !== 'admin') {
        user.role = 'admin';
        needsSave = true;
      }
      if (!user.emailVerified) {
        user.emailVerified = true;
        needsSave = true;
      }
      const isPassCorrect = user.passwordHash ? await bcrypt.compare(adminPassword, user.passwordHash) : false;
      if (!isPassCorrect) {
        user.passwordHash = await bcrypt.hash(adminPassword, 12);
        needsSave = true;
      }
      if (needsSave) {
        await user.save();
      }
    }
  }

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


module.exports = router;
