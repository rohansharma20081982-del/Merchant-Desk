const sentEmails = [];

class MockEmailProvider {
  constructor(options = {}) {
    this.name = 'mock';
    this.from = options.from || 'no-reply@merchantdesk.local';
  }

  async sendEmail({ to, subject, html, text }) {
    const record = {
      from: this.from,
      to,
      subject,
      html,
      text,
      sentAt: new Date()
    };
    sentEmails.push(record);

    // Mask email for logging (e.g. ro***@domain.com)
    const [local, domain] = (to || '').split('@');
    const masked = local
      ? (local.length > 2 ? local.slice(0, 2) + '***' : local[0] + '***') + '@' + (domain || 'domain.com')
      : '***@***';

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[Email][Mock] Sent to ${masked}: "${subject}"`);
    }

    return {
      success: true,
      provider: 'mock',
      messageId: 'mock-mail-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    };
  }

  static getSentEmails() {
    return sentEmails;
  }

  static getLastEmail() {
    return sentEmails[sentEmails.length - 1] || null;
  }

  static clear() {
    sentEmails.length = 0;
  }
}

module.exports = MockEmailProvider;
