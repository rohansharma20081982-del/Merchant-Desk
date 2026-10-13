const { Schema, model } = require('mongoose');

// Append-only record of every balance movement, written in the same transaction as the movement.
const ledgerSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    type: {
      type: String,
      enum: ['escrow_lock', 'escrow_return', 'escrow_release', 'received_from_escrow', 'admin_credit'],
      required: true
    },
    amountMinor: { type: Number, required: true },
    availableAfter: Number,
    escrowAfter: Number,
    note: String
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = model('LedgerEntry', ledgerSchema);
