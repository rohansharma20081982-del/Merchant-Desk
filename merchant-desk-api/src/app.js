const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cfg = require('./config');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind one reverse proxy (nginx, a load balancer). Adjust for your host.

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'upgrade-insecure-requests': null, // lets the app load over plain http on a local network while testing
        'script-src': ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://apis.google.com'],
        'frame-src': ["'self'", 'https://accounts.google.com'],
        'connect-src': ["'self'", 'ws:', 'wss:', 'https://accounts.google.com', 'https://oauth2.googleapis.com'],
        'img-src': ["'self'", 'data:', 'https://*.googleusercontent.com', 'https://lh3.googleusercontent.com']
      }
    }
  })
);
app.use(cors({ origin: cfg.corsOrigins }));
app.use(express.json({ limit: '50kb' }));

const { csrfProtection } = require('./middleware/csrf');

const general = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Public numbers and auth features the app needs before sign-in.
app.get('/api/config', (req, res) =>
  res.json({
    appName: cfg.appName,
    rate: cfg.rateMinor / 100,
    limits: { minInr: cfg.minOrderMinor / 100, maxInr: cfg.maxOrderMinor / 100, dailyInr: cfg.dailyLimitMinor / 100 },
    paymentWindowMinutes: cfg.paymentWindowMs / 60000,
    googleClientId: cfg.googleClientId || null,
    requirePhoneVerification: cfg.requirePhoneVerification,
    requireEmailVerification: cfg.requireEmailVerification
  })
);

app.use(csrfProtection);

const authRouter = require('./routes/auth');
app.use('/auth', authLimit, authRouter);
app.use('/api', general);
app.use('/api/auth', authLimit, authRouter);
app.use('/api/me', require('./routes/me'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/support', require('./routes/support'));

// The mobile web app. The service worker must never be cached so updates reach phones.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, file) => {
      if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
