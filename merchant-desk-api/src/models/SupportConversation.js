const { Schema, model } = require('mongoose');

const supportConversationSchema = new Schema(
  {
    customer: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    lastMessageText: { type: String, default: '' },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastSenderRole: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    unreadAdminCount: { type: Number, default: 0 },
    unreadCustomerCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = model('SupportConversation', supportConversationSchema);
