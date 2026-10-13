const test = require('node:test');
const assert = require('node:assert/strict');
const { usdtToMinor, inrFor, fromMinor } = require('../src/money');

test('USDT converts to hundredths without float drift', () => {
  assert.equal(usdtToMinor(10), 1000);
  assert.equal(usdtToMinor(0.1 + 0.2 + 0.7), 100); // 1.0000000000000002 style input is accepted
  assert.equal(usdtToMinor(12.34), 1234);
});

test('more than 2 decimal places is rejected', () => {
  assert.throws(() => usdtToMinor(1.234), /2 decimal/);
  assert.throws(() => usdtToMinor(0), /greater than zero/);
  assert.throws(() => usdtToMinor(-5), /greater than zero/);
});

test('INR owed is usdt x rate, in paise', () => {
  assert.equal(inrFor(1000, 10900), 109000); // 10 USDT at Rs 109 = Rs 1,090.00
  assert.equal(inrFor(5000, 10900), 545000); // 50 USDT = Rs 5,450.00
  assert.equal(fromMinor(inrFor(2000, 10900)), 2180);
});
