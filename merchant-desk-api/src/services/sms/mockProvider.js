const sentMessages = [];

class MockSmsProvider {
  constructor(options = {}) {
    this.name = 'mock';
    this.senderId = options.senderId || 'MRCHNT';
    this.templateId = options.templateId || '1007161234567890123';
  }

  async sendSms({ to, message, templateId }) {
    const record = {
      to,
      message,
      templateId: templateId || this.templateId,
      senderId: this.senderId,
      sentAt: new Date()
    };
    sentMessages.push(record);

    // Mask phone number in logs (+91XXXXXX3210)
    const masked = to && to.length >= 7
      ? to.slice(0, 3) + 'X'.repeat(Math.max(1, to.length - 7)) + to.slice(-4)
      : '***';

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[SMS][Mock] Sent to ${masked} (DLT ID: ${record.templateId}): ${message}`);
    }

    return {
      success: true,
      provider: 'mock',
      messageId: 'mock-sms-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    };
  }

  static getSentMessages() {
    return sentMessages;
  }

  static getLastMessage() {
    return sentMessages[sentMessages.length - 1] || null;
  }

  static clear() {
    sentMessages.length = 0;
  }
}

module.exports = MockSmsProvider;
