const { Schema, model } = require('mongoose');

const supportMessageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'SupportConversation', required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: { type: String, enum: ['customer', 'admin'], required: true },
    senderName: { type: String, required: true },
    text: { type: String, required: true, maxlength: 1000 },
    isRead: { type: Boolean, default: false }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

supportMessageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = model('SupportMessage', supportMessageSchema);
