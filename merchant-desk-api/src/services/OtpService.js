const crypto = require('node:crypto');
const cfg = require('../config');
const Otp = require('../models/Otp');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { HttpError } = require('../errors');
const { getSmsProvider } = require('./sms');
const { getEmailProvider } = require('./email');

class OtpService {
  /**
   * Normalizes a phone number into E.164 format. Defaults country to India (+91).
   * Supports inputs with spaces, hyphens, leading 0 or +91.
   */
  static normalizePhoneNumber(raw, defaultCountryCode = '+91') {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim().replace(/[\s\-()]/g, '');
    if (!s) return null;

    if (s.startsWith('+')) {
      // Validate E.164: + followed by 8-15 digits
      if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
      throw new HttpError(400, 'Invalid international phone number format');
    }

    // If starts with 00 (common international prefix), replace with +
    if (s.startsWith('00')) {
      s = '+' + s.slice(2);
      if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
      throw new HttpError(400, 'Invalid phone number format');
    }

    // Leading 0 in India (e.g. 09876543210)
    if (s.startsWith('0') && s.length === 11) {
      s = s.slice(1);
    }

    // 10-digit Indian mobile number
    if (/^[6-9]\d{9}$/.test(s)) {
      return defaultCountryCode + s;
    }

    // Generic digits
    if (/^\d{8,14}$/.test(s)) {
      return defaultCountryCode + s;
    }

    throw new HttpError(400, 'Invalid phone number format. Provide a valid 10-digit number or international E.164 format');
  }

  /**
   * Masks a phone number or email address for safe logging and responses.
   * e.g., +919876543210 -> +91XXXXXX3210
   *       user@example.com -> us***@example.com
   */
  static maskDestination(dest) {
    if (!dest) return '***';
    const s = String(dest).trim();
    if (s.includes('@')) {
      const [local, domain] = s.split('@');
      const maskedLocal = local.length <= 2 ? local[0] + '***' : local.slice(0, 2) + '***';
      return `${maskedLocal}@${domain || 'domain.com'}`;
    }
    // Phone
    if (s.startsWith('+')) {
      const countryAndStart = s.slice(0, 3);
      const last4 = s.slice(-4);
      const middleLen = Math.max(1, s.length - countryAndStart.length - 4);
      return `${countryAndStart}${'X'.repeat(middleLen)}${last4}`;
    }
    return s.slice(0, 2) + 'XXXX' + s.slice(-2);
  }

  /**
   * Generates a 6-digit numeric OTP from a cryptographically secure RNG.
   */
  static generateOtpCode() {
    return String(crypto.randomInt(100000, 1000000));
  }

  /**
   * Calculates HMAC-SHA256 hash using the server secret.
   */
  static hashOtp(otpCode) {
    return crypto.createHmac('sha256', cfg.otpSecret).update(String(otpCode)).digest('hex');
  }

  /**
   * Compares an input OTP with stored hash using constant-time comparison.
   */
  static verifyOtpHash(candidateCode, storedHash) {
    if (!candidateCode || !storedHash) return false;
    const candidateHash = OtpService.hashOtp(candidateCode);
    const candidateBuf = Buffer.from(candidateHash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (candidateBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(candidateBuf, storedBuf);
  }

  /**
   * Writes an audit log entry.
   */
  static async logAudit({ event, channel, destination, purpose, user, ip, success, reason, metadata }) {
    try {
      await AuditLog.create({
        event,
        channel,
        destinationMasked: OtpService.maskDestination(destination),
        purpose: purpose || '',
        user: user ? (user._id || user.id || user) : null,
        ip: ip || '',
        success: Boolean(success),
        reason: reason || null,
        metadata: metadata || {}
      });
    } catch (e) {
      console.error('[AuditLog] Failed to persist audit log:', e.message);
    }
  }

  /**
   * Checks rate limiting for an IP and destination.
   * - Resend cooldown (30-60s)
   * - Hourly limit per destination (max 5 sends)
   * - Hourly limit per IP (max 15 sends)
   */
  static async checkSendRateLimits(destination, ip) {
    const now = Date.now();
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    const cooldownMs = cfg.otpCooldownSeconds * 1000;

    // Check resend cooldown on this destination
    const latest = await Otp.findOne({ destination }).sort({ createdAt: -1 });
    if (latest && (now - new Date(latest.createdAt).getTime()) < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - (now - new Date(latest.createdAt).getTime())) / 1000);
      const err = new HttpError(429, `Please wait ${waitSeconds} seconds before requesting another code`);
      err.retryAfter = waitSeconds;
      throw err;
    }

    // Destination hourly send limit
    const destSendsLastHour = await Otp.countDocuments({
      destination,
      createdAt: { $gte: oneHourAgo }
    });
    if (destSendsLastHour >= cfg.otpMaxSendsPerHour) {
      const err = new HttpError(429, 'Too many verification requests for this destination. Try again in an hour');
      err.retryAfter = 3600;
      throw err;
    }

    // IP hourly send limit (e.g. 15 per IP)
    if (ip) {
      const ipSendsLastHour = await Otp.countDocuments({
        ip,
        createdAt: { $gte: oneHourAgo }
      });
      if (ipSendsLastHour >= 15) {
        const err = new HttpError(429, 'Too many requests from this network. Try again later');
        err.retryAfter = 3600;
        throw err;
      }
    }
  }

  /**
   * Generates and dispatches an OTP.
   * Automatically invalidates prior pending OTPs for the same destination & purpose.
   */
  static async sendOtp({ channel, destination, purpose, user = null, ip = '' }) {
    if (channel === 'email') {
      throw new HttpError(400, 'Email OTP verification has been removed. Please use Click to Log in with Gmail.');
    }
    if (channel !== 'sms') {
      throw new HttpError(400, 'Invalid OTP channel. Must be sms');
    }
    if (!['signup', 'login', 'verify_contact', 'password_reset'].includes(purpose)) {
      throw new HttpError(400, 'Invalid OTP purpose');
    }

    let dest = destination;
    if (channel === 'sms') {
      dest = OtpService.normalizePhoneNumber(destination);
    } else {
      dest = String(destination || '').trim().toLowerCase();
      if (!dest || !dest.includes('@')) throw new HttpError(400, 'Invalid email destination');
    }

    // Enforce rate limits
    await OtpService.checkSendRateLimits(dest, ip);

    // Invalidate older unused OTPs for the same destination and purpose
    await Otp.updateMany(
      { destination: dest, purpose, status: 'pending', consumedAt: null },
      { $set: { status: 'invalidated' } }
    );

    // Generate fresh secure 6-digit OTP
    const rawOtp = OtpService.generateOtpCode();
    const otpHash = OtpService.hashOtp(rawOtp);
    const expiresAt = new Date(Date.now() + cfg.otpTtlSeconds * 1000);

    const otpDoc = await Otp.create({
      user: user ? (user._id || user.id || user) : null,
      channel,
      destination: dest,
      otpHash,
      purpose,
      expiresAt,
      attempts: 0,
      consumedAt: null,
      ip,
      status: 'pending'
    });

    const appName = cfg.appName;
    const smsText = `Your ${appName} verification code is ${rawOtp}. Valid for 5 minutes. Do not share it with anyone.`;
    const emailSubject = `${appName} Verification Code: ${rawOtp}`;
    const emailHtml = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
        <h2 style="color:#0f172a;margin-top:0">${appName} Verification</h2>
        <p style="color:#475569;font-size:15px">Your single-use verification code is:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#059669;padding:16px 0;text-align:center;background:#f0fdf4;border-radius:8px;margin:16px 0">
          ${rawOtp}
        </div>
        <p style="color:#64748b;font-size:13px">This code is valid for 5 minutes. Do not share it with anyone.</p>
      </div>
    `;

    try {
      if (channel === 'sms') {
        const smsProvider = getSmsProvider();
        await smsProvider.sendSms({
          to: dest,
          message: smsText,
          templateId: cfg.smsTemplateId
        });
      } else {
        const emailProvider = getEmailProvider();
        await emailProvider.sendEmail({
          to: dest,
          subject: emailSubject,
          html: emailHtml,
          text: smsText
        });
      }

      await OtpService.logAudit({
        event: 'otp_send',
        channel,
        destination: dest,
        purpose,
        user,
        ip,
        success: true,
        metadata: { otpId: otpDoc._id }
      });

      return {
        success: true,
        destinationMasked: OtpService.maskDestination(dest),
        cooldownSeconds: cfg.otpCooldownSeconds,
        expiresInSeconds: cfg.otpTtlSeconds
      };
    } catch (sendErr) {
      await OtpService.logAudit({
        event: 'otp_send',
        channel,
        destination: dest,
        purpose,
        user,
        ip,
        success: false,
        reason: sendErr.message
      });
      throw new HttpError(500, `Failed to send verification code: ${sendErr.message}`);
    }
  }

  /**
   * Verifies an OTP code against destination and purpose.
   * - Max 5 attempts; invalidates OTP once limit reached.
   * - Constant-time check.
   * - Enforces 5-minute expiry and single-use consumption.
   * - If user is provided / logged in, marks contact verified.
   */
  static async verifyOtp({ channel, destination, purpose, otp, user = null, ip = '' }) {
    if (channel === 'email') {
      throw new HttpError(400, 'Email OTP verification has been removed. Please use Click to Log in with Gmail.');
    }
    if (!otp || typeof otp !== 'string' || otp.trim().length !== 6) {
      throw new HttpError(400, 'Enter a valid 6-digit verification code');
    }

    let dest = destination;
    if (channel === 'sms') {
      dest = OtpService.normalizePhoneNumber(destination);
    } else {
      dest = String(destination || '').trim().toLowerCase();
    }

    const cleanOtp = otp.trim();

    // Find the latest pending OTP for this destination and purpose
    const otpDoc = await Otp.findOne({
      destination: dest,
      purpose,
      status: 'pending',
      consumedAt: null
    }).sort({ createdAt: -1 });

    if (!otpDoc) {
      await OtpService.logAudit({
        event: 'otp_verify_failure',
        channel,
        destination: dest,
        purpose,
        user,
        ip,
        success: false,
        reason: 'No active OTP found or expired'
      });
      throw new HttpError(400, 'Invalid or expired verification code. Please request a new code');
    }

    // Check expiry
    if (new Date() > new Date(otpDoc.expiresAt)) {
      otpDoc.status = 'expired';
      await otpDoc.save();
      await OtpService.logAudit({
        event: 'otp_verify_failure',
        channel,
        destination: dest,
        purpose,
        user,
        ip,
        success: false,
        reason: 'OTP expired'
      });
      throw new HttpError(400, 'Verification code has expired. Please request a new code');
    }

    // Increment attempts
    otpDoc.attempts += 1;

    // Verify hash with constant-time comparison
    const isValid = OtpService.verifyOtpHash(cleanOtp, otpDoc.otpHash);

    if (!isValid) {
      if (otpDoc.attempts >= cfg.otpMaxAttempts) {
        otpDoc.status = 'invalidated';
        await otpDoc.save();
        await OtpService.logAudit({
          event: 'otp_verify_failure',
          channel,
          destination: dest,
          purpose,
          user,
          ip,
          success: false,
          reason: 'Max attempts exceeded; OTP invalidated'
        });
        throw new HttpError(400, 'Too many incorrect attempts. This code is now invalid. Please request a new one');
      }

      await otpDoc.save();
      const remaining = cfg.otpMaxAttempts - otpDoc.attempts;
      await OtpService.logAudit({
        event: 'otp_verify_failure',
        channel,
        destination: dest,
        purpose,
        user,
        ip,
        success: false,
        reason: `Incorrect code (${remaining} attempts remaining)`
      });
      throw new HttpError(400, `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining`);
    }

    // Success: Mark as consumed (Single Use)
    otpDoc.consumedAt = new Date();
    otpDoc.status = 'consumed';
    if (user && !otpDoc.user) {
      otpDoc.user = user._id || user.id || user;
    }
    await otpDoc.save();

    // If user is authenticated, mark matching verified contact on user record
    if (user) {
      const u = user.save ? user : await User.findById(user._id || user.id || user);
      if (u) {
        if (channel === 'sms') {
          u.phone = dest;
          u.phoneVerified = true;
          u.phoneVerifiedAt = new Date();
        } else if (channel === 'email') {
          u.emailVerified = true;
          u.emailVerifiedAt = new Date();
        }
        await u.save();
      }
    }

    await OtpService.logAudit({
      event: 'otp_verify_success',
      channel,
      destination: dest,
      purpose,
      user,
      ip,
      success: true,
      metadata: { otpId: otpDoc._id }
    });

    return {
      success: true,
      destination: dest,
      verified: true
    };
  }
}

module.exports = OtpService;
