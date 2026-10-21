class Fast2SmsProvider {
  constructor(options = {}) {
    this.name = 'fast2sms';
    this.apiKey = options.apiKey || process.env.FAST2SMS_API_KEY;
    this.senderId = options.senderId || process.env.SMS_SENDER_ID || 'TXTIND';
  }

  async sendSms({ to, message }) {
    if (!this.apiKey) {
      throw new Error('Fast2SMS apiKey not configured (FAST2SMS_API_KEY)');
    }

    // Fast2SMS quick transactional SMS endpoint
    const cleanNumber = to.replace(/\D/g, '').slice(-10); // 10 digit Indian number
    const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        'authorization': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        route: 'q',
        message: message,
        numbers: cleanNumber
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.return === false) {
      throw new Error((data.message && data.message[0]) || `Fast2SMS failed with HTTP ${res.status}`);
    }

    return {
      success: true,
      provider: 'fast2sms',
      messageId: (data.request_id) || ('fast2sms-' + Date.now())
    };
  }
}

module.exports = Fast2SmsProvider;
