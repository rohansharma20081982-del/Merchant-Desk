const { Schema, model } = require('mongoose');

const auditLogSchema = new Schema(
  {
    event: {
      type: String,
      enum: ['otp_send', 'otp_verify_success', 'otp_verify_failure', 'phone_login_request', 'phone_login_success', 'phone_login_failure', 'account_rate_limited'],
      required: true,
      index: true
    },
    channel: { type: String, enum: ['sms', 'email', 'system'], default: 'system' },
    destinationMasked: { type: String, default: '' },
    purpose: { type: String, default: '' },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    success: { type: Boolean, required: true },
    reason: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

auditLogSchema.index({ destinationMasked: 1, createdAt: -1 });
auditLogSchema.index({ event: 1, createdAt: -1 });

module.exports = model('AuditLog', auditLogSchema);
