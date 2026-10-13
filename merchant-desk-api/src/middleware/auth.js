const jwt = require('jsonwebtoken');
const cfg = require('../config');
const User = require('../models/User');
const { HttpError } = require('../errors');

async function requireAuth(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Sign in required');
    let payload;
    try {
      payload = jwt.verify(token, cfg.jwtSecret);
    } catch (e) {
      throw new HttpError(401, 'Your session has expired. Sign in again');
    }
    const user = await User.findById(payload.sub);
    if (!user) throw new HttpError(401, 'Sign in required');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'This is not available for your account type'));

module.exports = { requireAuth, requireRole };
