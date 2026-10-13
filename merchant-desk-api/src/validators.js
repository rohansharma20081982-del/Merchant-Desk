const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const upiId = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{1,31}$/, 'Enter a UPI ID like name@bank');
const usdtAmount = z.number().positive().max(100000);
const pageLimit = z.coerce.number().int().min(1).max(100).default(30);

const normalizeName = (s) => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();

module.exports = { objectId, upiId, usdtAmount, pageLimit, normalizeName };
