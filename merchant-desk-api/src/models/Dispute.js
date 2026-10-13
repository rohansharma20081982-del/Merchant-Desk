const crypto = require('crypto');
const { Schema, model } = require('mongoose');

const REASONS = ['payment_not_received', 'wrong_amount', 'payer_name_mismatch', 'other'];

const disputeSchema = new Schema(
  {
    ref: { type: String, unique: true, default: () => 'D-' + crypto.randomBytes(3).toString('hex').toUpperCase() },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    openedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: REASONS, required: true },
    details: { type: String, required: true, maxlength: 2000 },
    files: [{ _id: false, name: String, originalName: String }],
    status: { type: String, enum: ['review', 'resolved'], default: 'review', index: true },
    resolution: {
      outcome: { type: String, enum: ['release_to_buyer', 'return_to_merchant'] },
      note: { type: String, maxlength: 1000 },
      by: { type: Schema.Types.ObjectId, ref: 'User' },
      at: Date
    }
  },
  { timestamps: true }
);

// At most one open dispute per order.
disputeSchema.index({ order: 1 }, { unique: true, partialFilterExpression: { status: 'review' } });

module.exports = model('Dispute', disputeSchema);
module.exports.REASONS = REASONS;
