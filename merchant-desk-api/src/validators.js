const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const upiId = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{1,31}$/, 'Enter a UPI ID like name@bank');
const usdtAmount = z.number().positive().max(100000);
const pageLimit = z.coerce.number().int().min(1).max(100).default(30);

const normalizeName = (s) => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();

// OTP and Phone Auth Validators
const phoneInput = z.string().trim().min(7, 'Phone number is too short').max(20, 'Phone number is too long');
const otpCode = z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit numeric verification code');

const otpSendSchema = z.object({
  channel: z.enum(['sms']),
  destination: z.string().trim().min(3, 'Destination is required'),
  purpose: z.enum(['signup', 'login', 'verify_contact', 'password_reset'])
});

const otpVerifySchema = z.object({
  channel: z.enum(['sms']),
  destination: z.string().trim().min(3, 'Destination is required'),
  purpose: z.enum(['signup', 'login', 'verify_contact', 'password_reset']),
  otp: otpCode
});

const phoneLoginRequestSchema = z.object({
  phone: phoneInput
});

const phoneLoginVerifySchema = z.object({
  phone: phoneInput,
  otp: otpCode
});

module.exports = {
  objectId,
  upiId,
  usdtAmount,
  pageLimit,
  normalizeName,
  phoneInput,
  otpCode,
  otpSendSchema,
  otpVerifySchema,
  phoneLoginRequestSchema,
  phoneLoginVerifySchema
};
