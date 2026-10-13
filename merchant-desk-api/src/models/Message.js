const { Schema, model } = require('mongoose');

const messageSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User' }, // empty for system messages
    kind: { type: String, enum: ['user', 'system'], default: 'user' },
    text: { type: String, required: true, maxlength: 500 },
    readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }]
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

messageSchema.index({ order: 1, createdAt: 1 });

module.exports = model('Message', messageSchema);
