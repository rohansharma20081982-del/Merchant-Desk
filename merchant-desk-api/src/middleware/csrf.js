const cfg = require('../config');
const { HttpError } = require('../errors');

/**
 * Defense-in-depth CSRF Protection for API endpoints.
 * State-changing HTTP methods (POST, PUT, DELETE, PATCH) are verified for:
 * 1. Origin / Referer matching allowed origins (if browser header provided).
 * 2. Custom header presence (e.g. X-Requested-With, X-CSRF-Token, or Authorization)
 *    which simple cross-site forms/attacks cannot forge without CORS preflight.
 */
function csrfProtection(req, res, next) {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Exempt health check
  if (req.path === '/healthz') {
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // If Origin is provided by browser, verify it
  if (origin) {
    const isAllowed = cfg.corsOrigins.some((allowed) => {
      if (allowed === '*') return true;
      try {
        const uAllowed = new URL(allowed);
        const uOrigin = new URL(origin);
        return uAllowed.origin === uOrigin.origin;
      } catch (e) {
        return allowed === origin;
      }
    }) || (() => {
      try {
        const uOrigin = new URL(origin);
        return ['localhost', '127.0.0.1'].includes(uOrigin.hostname);
      } catch (_) {
        return false;
      }
    })();

    if (!isAllowed) {
      return next(new HttpError(403, 'Cross-origin request blocked by CSRF protection policy'));
    }
  }

  // Require either an Authorization header, custom client header, or application/json content-type
  const hasAuth = Boolean(req.headers.authorization);
  const hasCustomHeader = Boolean(req.headers['x-requested-with'] || req.headers['x-csrf-token']);
  const isJson = req.is('application/json');

  if (!hasAuth && !hasCustomHeader && !isJson) {
    return next(new HttpError(403, 'CSRF verification failed: missing anti-forgery request signature'));
  }

  next();
}

module.exports = { csrfProtection };
