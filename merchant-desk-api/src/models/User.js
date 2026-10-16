const { Schema, model } = require('mongoose');

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['merchant', 'buyer', 'admin'], required: true },

    // Identity check. Legal name and last 4 chars of PAN are stored.
    kyc: {
      status: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
      legalName: String,
      panLast4: { type: String, maxlength: 4 },
      submittedAt: Date,
      reviewedAt: Date,
      reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      rejectReason: String
    },

    // Account block. Blocked accounts cannot log in or place orders.
    blocked: { type: Boolean, default: false },
    blockedAt: Date,
    blockReason: String,

    // The one verified payment account. The holder name must match kyc.legalName.
    paymentAccount: { upi: String, holderName: String, verifiedAt: Date },
    // A replacement waiting for admin approval. The current account keeps serving open orders.
    pendingPaymentAccount: { upi: String, submittedAt: Date },

    online: { type: Boolean, default: false },

    // Integer minor units (hundredths of a USDT).
    balance: {
      available: { type: Number, default: 0, min: 0 },
      escrow: { type: Number, default: 0, min: 0 }
    }
  },
  { timestamps: true }
);

// One UPI ID can belong to one merchant only.
userSchema.index(
  { 'paymentAccount.upi': 1 },
  { unique: true, partialFilterExpression: { 'paymentAccount.upi': { $type: 'string' } } }
);

module.exports = model('User', userSchema);
