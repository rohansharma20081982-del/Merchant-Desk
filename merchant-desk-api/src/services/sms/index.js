const MockSmsProvider = require('./mockProvider');
const TwilioSmsProvider = require('./twilioProvider');
const Msg91SmsProvider = require('./msg91Provider');
const Fast2SmsProvider = require('./fast2smsProvider');
const cfg = require('../../config');

function createSmsProvider(type = cfg.smsProvider) {
  switch ((type || '').toLowerCase()) {
    case 'twilio':
      return new TwilioSmsProvider({
        accountSid: cfg.twilioAccountSid,
        authToken: cfg.twilioAuthToken,
        fromNumber: cfg.twilioFromNumber
      });
    case 'msg91':
      return new Msg91SmsProvider({
        authKey: cfg.msg91AuthKey,
        senderId: cfg.smsSenderId || cfg.msg91SenderId,
        templateId: cfg.smsTemplateId
      });
    case 'fast2sms':
      return new Fast2SmsProvider({
        apiKey: cfg.fast2smsApiKey,
        senderId: cfg.smsSenderId
      });
    case 'mock':
    default:
      return new MockSmsProvider({
        senderId: cfg.smsSenderId,
        templateId: cfg.smsTemplateId
      });
  }
}

let defaultProvider = null;
function getSmsProvider() {
  if (!defaultProvider) {
    defaultProvider = createSmsProvider(cfg.smsProvider);
  }
  return defaultProvider;
}

module.exports = {
  createSmsProvider,
  getSmsProvider,
  MockSmsProvider,
  TwilioSmsProvider,
  Msg91SmsProvider,
  Fast2SmsProvider
};
