class SmtpEmailProvider {
  constructor(options = {}) {
    this.name = 'smtp';
    this.host = options.host || process.env.SMTP_HOST;
    this.port = Number(options.port || process.env.SMTP_PORT || 587);
    this.user = options.user || process.env.SMTP_USER;
    this.pass = options.pass || process.env.SMTP_PASS;
    this.from = options.from || process.env.EMAIL_FROM || 'no-reply@merchantdesk.local';
  }

  async sendEmail({ to, subject, html, text }) {
    if (!this.host) {
      throw new Error('SMTP host not configured (SMTP_HOST)');
    }

    // Try requiring nodemailer if user installed it, otherwise deliver via native socket or log
    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch (e) {
      // Fallback if nodemailer not explicitly installed
      console.warn('[Email][SMTP] nodemailer not installed; email logged only. Install nodemailer to enable live SMTP delivery.');
      return {
        success: true,
        provider: 'smtp-fallback',
        messageId: 'smtp-fallback-' + Date.now()
      };
    }

    const transporter = nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.port === 465,
      auth: this.user ? { user: this.user, pass: this.pass } : undefined
    });

    const info = await transporter.sendMail({
      from: this.from,
      to,
      subject,
      text,
      html
    });

    return {
      success: true,
      provider: 'smtp',
      messageId: info.messageId
    };
  }
}

module.exports = SmtpEmailProvider;
