class Msg91SmsProvider {
  constructor(options = {}) {
    this.name = 'msg91';
    this.authKey = options.authKey || process.env.MSG91_AUTH_KEY;
    this.senderId = options.senderId || process.env.MSG91_SENDER_ID || 'MRCHNT';
    this.templateId = options.templateId || process.env.SMS_DLT_TE_ID;
  }

  async sendSms({ to, message, templateId }) {
    if (!this.authKey) {
      throw new Error('MSG91 authKey not configured (MSG91_AUTH_KEY)');
    }

    // MSG91 flow API or standard SMS API
    const cleanMobile = to.replace(/\D/g, '');
    const url = 'https://api.msg91.com/api/v5/flow/';
    const payload = {
      template_id: templateId || this.templateId,
      sender: this.senderId,
      short_url: '0',
      mobiles: cleanMobile,
      // fallback body if template params not used
      var: message
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'authkey': this.authKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type === 'error') {
      throw new Error(data.message || `MSG91 failed with HTTP ${res.status}`);
    }

    return {
      success: true,
      provider: 'msg91',
      messageId: data.message || 'msg91-' + Date.now()
    };
  }
}

module.exports = Msg91SmsProvider;
