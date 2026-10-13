const { HttpError } = require('./errors');

// USDT is kept in hundredths ("minor" units), INR in paise, so balances never drift with floats.

/** Convert a decimal USDT amount to integer hundredths. Rejects more than 2 decimal places. */
function usdtToMinor(n) {
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'Amount must be greater than zero');
  const minor = Math.round(n * 100);
  if (Math.abs(minor / 100 - n) > 1e-9) throw new HttpError(400, 'Use at most 2 decimal places');
  return minor;
}

/** INR (paise) owed for a USDT amount (hundredths) at a rate in paise per 1 USDT. */
function inrFor(usdtMinor, rateMinor) {
  return Math.round((usdtMinor * rateMinor) / 100);
}

const fromMinor = (m) => m / 100;

module.exports = { usdtToMinor, inrFor, fromMinor };
