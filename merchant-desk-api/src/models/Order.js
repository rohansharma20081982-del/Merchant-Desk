const crypto = require('crypto');
const { Schema, model } = require('mongoose');

const STATUSES = ['awaiting_payment', 'paid', 'completed', 'disputed', 'cancelled'];

const orderSchema = new Schema(
  {
    ref: { type: String, unique: true, default: () => crypto.randomBytes(4).toString('hex').toUpperCase() },
    merchant: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    buyer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    usdtMinor: { type: Number, required: true }, // hundredths of USDT
    rateMinor: { type: Number, required: true }, // paise per 1 USDT, fixed when the order is placed
    inrMinor: { type: Number, required: true }, // paise

    status: { type: String, enum: STATUSES, default: 'awaiting_payment', index: true },

    // Snapshots taken at order time, so a later account change does not alter an open order.
    payTo: { upi: String, holderName: String },
    expectedPayerName: String,

    utr: String, // bank reference the buyer entered when marking the payment as sent
    expiresAt: { type: Date, required: true },
    paidAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelReason: String,

    history: [
      {
        _id: false,
        status: String,
        at: { type: Date, default: Date.now },
        by: { type: Schema.Types.ObjectId, ref: 'User' },
        note: String
      }
    ]
  },
  { timestamps: true }
);

orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index({ merchant: 1, createdAt: -1 });

module.exports = model('Order', orderSchema);
module.exports.STATUSES = STATUSES;
