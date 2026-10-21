const MockEmailProvider = require('./mockProvider');
const SmtpEmailProvider = require('./smtpProvider');
const cfg = require('../../config');

function createEmailProvider(type = cfg.emailProvider) {
  switch ((type || '').toLowerCase()) {
    case 'smtp':
      return new SmtpEmailProvider({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        user: cfg.smtpUser,
        pass: cfg.smtpPass,
        from: cfg.emailFrom
      });
    case 'mock':
    default:
      return new MockEmailProvider({
        from: cfg.emailFrom
      });
  }
}

let defaultEmailProvider = null;
function getEmailProvider() {
  if (!defaultEmailProvider) {
    defaultEmailProvider = createEmailProvider(cfg.emailProvider);
  }
  return defaultEmailProvider;
}

module.exports = {
  createEmailProvider,
  getEmailProvider,
  MockEmailProvider,
  SmtpEmailProvider
};
