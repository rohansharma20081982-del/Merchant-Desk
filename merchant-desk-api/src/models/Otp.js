const { Schema, model } = require('mongoose');

const otpSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    destination: { type: String, required: true, index: true, lowercase: true, trim: true },
    otpHash: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['signup', 'login', 'verify_contact', 'password_reset'],
      required: true,
      index: true
    },
    expiresAt: { type: Date, required: true, index: true },
    attempts: { type: Number, default: 0, min: 0 },
    consumedAt: { type: Date, default: null },
    ip: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'consumed', 'invalidated', 'expired'], default: 'pending', index: true }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual aliases to support snake_case requirements as specified
otpSchema.virtual('otp_hash').get(function () { return this.otpHash; }).set(function (v) { this.otpHash = v; });
otpSchema.virtual('expires_at').get(function () { return this.expiresAt; }).set(function (v) { this.expiresAt = v; });
otpSchema.virtual('consumed_at').get(function () { return this.consumedAt; }).set(function (v) { this.consumedAt = v; });
otpSchema.virtual('created_at').get(function () { return this.createdAt; });

// Compound indexes for fast rate-limiting, queries and cleanup
otpSchema.index({ destination: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ ip: 1, createdAt: -1 });

module.exports = model('Otp', otpSchema);
