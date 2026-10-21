class TwilioSmsProvider {
  constructor(options = {}) {
    this.name = 'twilio';
    this.accountSid = options.accountSid || process.env.TWILIO_ACCOUNT_SID;
    this.authToken = options.authToken || process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = options.fromNumber || process.env.TWILIO_FROM_NUMBER;
  }

  async sendSms({ to, message }) {
    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER)');
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const params = new URLSearchParams({
      To: to,
      From: this.fromNumber,
      Body: message
    });

    const authHeader = 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || `Twilio SMS failed with HTTP ${res.status}`);
    }

    return {
      success: true,
      provider: 'twilio',
      messageId: data.sid
    };
  }
}

module.exports = TwilioSmsProvider;
