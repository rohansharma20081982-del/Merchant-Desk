// End-to-end check against a running API and MongoDB.
//   1. npm run seed:admin   2. npm start   3. ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke
const BASE = process.env.API_URL || 'http://localhost:4000';
const stamp = Date.now();
let failed = 0;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`}`);
}

(async () => {
  const pw = 'correct-horse-battery';
  const admin = (await call('POST', '/api/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })).json;
  if (!admin.token) throw new Error('Admin login failed. Run npm run seed:admin first.');
  const A = admin.token;

  const m = (await call('POST', '/api/auth/register', { name: 'Smoke Merchant', email: `m${stamp}@example.test`, password: pw, role: 'merchant' })).json;
  const b = (await call('POST', '/api/auth/register', { name: 'Smoke Buyer', email: `b${stamp}@example.test`, password: pw, role: 'buyer' })).json;
  const M = m.token, B = b.token;

  // Identity and the one payment account
  check('merchant cannot go online before KYC', (await call('POST', '/api/me/online', { online: true }, M)).status, 403);
  await call('POST', '/api/me/kyc', { legalName: 'SMOKE MERCHANT', panLast4: 'ABCD' }, M);
  await call('POST', '/api/me/kyc', { legalName: 'SMOKE BUYER', panLast4: 'WXYZ' }, B);
  check('approve merchant KYC', (await call('POST', `/api/admin/kyc/${m.user.id}`, { decision: 'approve' }, A)).status, 200);
  check('approve buyer KYC', (await call('POST', `/api/admin/kyc/${b.user.id}`, { decision: 'approve' }, A)).status, 200);
  const upi = `smoke${stamp}@okhdfcbank`;
  check('submit payment account', (await call('PUT', '/api/me/payment-account', { upi }, M)).status, 200);
  check('name mismatch is rejected', (await call('POST', `/api/admin/payment-accounts/${m.user.id}`, { decision: 'approve', holderName: 'SOMEONE ELSE' }, A)).status, 409);
  check('matching name is approved', (await call('POST', `/api/admin/payment-accounts/${m.user.id}`, { decision: 'approve', holderName: 'Smoke Merchant' }, A)).status, 200);
  check('a buyer cannot register a payment account', (await call('PUT', '/api/me/payment-account', { upi }, B)).status, 403);

  // Funding and going online
  check('credit 100 USDT', (await call('POST', `/api/admin/users/${m.user.id}/credit`, { usdt: 100, note: 'smoke test' }, A)).json.user.balance.available, 100);
  check('merchant goes online', (await call('POST', '/api/me/online', { online: true }, M)).json.user.online, true);

  // Order 1: happy path
  const o1 = (await call('POST', '/api/orders', { merchantId: m.user.id, usdt: 10 }, B)).json.order;
  check('order 1 awaiting payment', o1.status, 'awaiting_payment');
  check('rupee amount is 10 x 109', o1.inr, 1090);
  let me = (await call('GET', '/api/me', null, M)).json.user;
  check('10 USDT locked in escrow', [me.balance.available, me.balance.escrow], [90, 10]);
  check('merchant cannot release before payment', (await call('POST', `/api/orders/${o1.id}/release`, { statementChecked: true }, M)).status, 409);
  check('buyer marks paid', (await call('POST', `/api/orders/${o1.id}/paid`, { utr: 'UTR123456789' }, B)).json.order.status, 'paid');
  check('release needs the statement confirmation', (await call('POST', `/api/orders/${o1.id}/release`, {}, M)).status, 400);
  check('merchant releases', (await call('POST', `/api/orders/${o1.id}/release`, { statementChecked: true }, M)).json.order.status, 'completed');
  check('release cannot run twice', (await call('POST', `/api/orders/${o1.id}/release`, { statementChecked: true }, M)).status, 409);
  me = (await call('GET', '/api/me', null, M)).json.user;
  const buyer = (await call('GET', '/api/me', null, B)).json.user;
  check('merchant balance after release', [me.balance.available, me.balance.escrow], [90, 0]);
  check('buyer received 10 USDT', buyer.balance.available, 10);

  // Order 2: dispute, resolved for the merchant
  const o2 = (await call('POST', '/api/orders', { merchantId: m.user.id, usdt: 20 }, B)).json.order;
  await call('POST', `/api/orders/${o2.id}/paid`, { utr: 'UTR987654321' }, B);
  const d = (await call('POST', '/api/disputes', { orderId: o2.id, reason: 'payment_not_received', details: 'Nothing arrived in my account after 30 minutes.' }, M)).json.dispute;
  check('dispute opened', d && d.status, 'review');
  check('order is disputed', (await call('GET', `/api/orders/${o2.id}`, null, M)).json.order.status, 'disputed');
  check('merchant cannot resolve own dispute', (await call('POST', `/api/admin/disputes/${d.id}/resolve`, { outcome: 'return_to_merchant', note: 'trying' }, M)).status, 403);
  check('admin resolves for merchant', (await call('POST', `/api/admin/disputes/${d.id}/resolve`, { outcome: 'return_to_merchant', note: 'No credit found on statement.' }, A)).json.dispute.status, 'resolved');
  me = (await call('GET', '/api/me', null, M)).json.user;
  check('escrow returned to merchant', [me.balance.available, me.balance.escrow], [90, 0]);

  // Order 3: buyer cancels before paying
  const o3 = (await call('POST', '/api/orders', { merchantId: m.user.id, usdt: 15 }, B)).json.order;
  check('buyer cancels', (await call('POST', `/api/orders/${o3.id}/cancel`, {}, B)).json.order.status, 'cancelled');

  // Chat over REST
  check('chat message sent', (await call('POST', `/api/orders/${o1.id}/messages`, { text: 'Thanks!' }, B)).status, 201);
  check('chat history readable', (await call('GET', `/api/orders/${o1.id}/messages`, null, M)).json.messages.some((x) => x.text === 'Thanks!'), true);

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
