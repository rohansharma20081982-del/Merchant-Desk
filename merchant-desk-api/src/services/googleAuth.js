const { OAuth2Client } = require('google-auth-library');
const cfg = require('../config');
const { HttpError } = require('../errors');

const client = new OAuth2Client(cfg.googleClientId || undefined);

/**
 * Verifies a Google ID token / credential and ensures that the user's email
 * is officially verified by Google.
 *
 * @param {string} idToken - The Google JWT credential from Google Identity Services.
 * @returns {Promise<{ googleId: string, email: string, name: string, picture: string|null, emailVerified: boolean }>}
 */
async function verifyGoogleToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw new HttpError(400, 'Google credential token is required');
  }

  let payload = null;

  // 1. Attempt verification with official google-auth-library if googleClientId is set
  if (cfg.googleClientId) {
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: cfg.googleClientId
      });
      payload = ticket.getPayload();
    } catch (err) {
      // Fall through to tokeninfo verification or throw informative error
      console.warn('google-auth-library verification failed, trying tokeninfo:', err.message);
    }
  }

  // 2. Query Google's authoritative tokeninfo endpoint to verify token validity, signature, and expiration
  if (!payload) {
    try {
      const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({}));
        throw new HttpError(401, errorData.error_description || 'Invalid or expired Google credential');
      }
      payload = await resp.json();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, 'Unable to verify Google credential with Google OAuth servers: ' + err.message);
    }
  }

  // 3. Verify issuer
  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!payload.iss || !validIssuers.includes(payload.iss)) {
    throw new HttpError(401, 'Invalid token issuer: expected Google');
  }

  // 4. Verify audience if googleClientId configured
  if (cfg.googleClientId && payload.aud !== cfg.googleClientId) {
    throw new HttpError(401, 'Google token audience does not match configured client ID');
  }

  // 5. Verify token expiration
  if (payload.exp && Number(payload.exp) * 1000 < Date.now()) {
    throw new HttpError(401, 'Google credential has expired');
  }

  // 6. Mandatory email verification check: email must be present and verified by Google
  if (!payload.email) {
    throw new HttpError(400, 'Google account did not return an email address');
  }

  const isEmailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!isEmailVerified) {
    throw new HttpError(400, 'Google account email is not verified by Google. Please verify your email with Google first.');
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase().trim(),
    name: payload.name || payload.given_name || payload.email.split('@')[0],
    picture: payload.picture || null,
    emailVerified: true
  };
}

module.exports = { verifyGoogleToken };
