// Runs public/app.js against a fake DOM and a fake API to catch runtime errors in every screen.
// No browser, no database and no packages needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const sleep = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function makeEnv(role) {
  const els = {};
  const el = (sel) => (els[sel] = els[sel] || {
    innerHTML: '', textContent: '', className: '', value: '', checked: false, disabled: false, scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {} }, contains: () => false, focus() {}, setAttribute() {}
  });
  const listeners = {};
  const doc = {
    body: { classList: { toggle() {}, add() {}, remove() {} } },
    hidden: false,
    querySelector: (s) => el(s),
    querySelectorAll: () => [],
    getElementById: (id) => el('#' + id),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }
  };

  const person = (id, name) => ({ id, name });
  const mk = (id, status, extra) => Object.assign({
    id, ref: id.toUpperCase(), status, usdt: 10, rate: 109, inr: 1090,
    merchant: person('m1', 'Meera Nair'), buyer: person('b1', 'Aman Kapoor'),
    payTo: { upi: 'meera@okhdfcbank', holderName: 'MEERA NAIR' }, expectedPayerName: 'AMAN KAPOOR', utr: 'UTR123456',
    expiresAt: new Date(Date.now() + 9 * 60000).toISOString(), createdAt: iso(5 * 60000), cancelReason: null, history: []
  }, extra);
  const orders = ['awaiting_payment', 'paid', 'completed', 'disputed', 'cancelled'].map((s, i) => mk('o' + i, s));
  const dispute = { id: 'd1', ref: 'D-1', orderId: 'o3', openedBy: 'b1', reason: 'payer_name_mismatch', details: 'Paid from a different name.', files: [{ name: 'a.pdf', originalName: 'a.pdf' }], status: 'review', resolution: null, createdAt: iso(3600000) };
  const kyc = { status: 'verified', legalName: 'MEERA NAIR', rejectReason: null };
  const users = {
    merchant: { id: 'm1', name: 'Meera Nair', email: 'm@example.test', role: 'merchant', kyc, online: true, balance: { available: 90, escrow: 10 },
      paymentAccount: { upi: 'meera@okhdfcbank', holderName: 'MEERA NAIR', verifiedAt: iso(86400000) }, pendingPaymentAccount: null },
    buyer: { id: 'b1', name: 'Aman Kapoor', email: 'a@example.test', role: 'buyer', kyc: { status: 'verified', legalName: 'AMAN KAPOOR', rejectReason: null }, online: false,
      balance: { available: 10, escrow: 0 }, paymentAccount: null, pendingPaymentAccount: null },
    admin: { id: 'a1', name: 'Support', email: 's@example.test', role: 'admin', kyc: { status: 'none' }, online: false, balance: { available: 0, escrow: 0 }, paymentAccount: null, pendingPaymentAccount: null }
  };
  const me = users[role];

  const routes = [
    [/^\/api\/config$/, () => ({ rate: 109, limits: { minInr: 500, maxInr: 100000, dailyInr: 500000 }, paymentWindowMinutes: 15 })],
    [/^\/api\/me$/, () => ({ user: me })],
    [/^\/api\/me\/stats/, () => ({ balance: me.balance, today: { completed: 2, volumeInr: 2180 }, completionRate: 80, openDisputes: 1 })],
    [/^\/api\/orders\/merchants/, () => ({ rate: 109, merchants: [{ id: 'm1', name: 'Meera Nair', availableUsdt: 90 }] })],
    [/^\/api\/orders\/(\w+)\/messages/, (m) => ({ messages: [
      { id: 'x1', order: m[1], sender: null, kind: 'system', text: 'Order placed.', createdAt: iso(60000) },
      { id: 'x2', order: m[1], sender: 'b1', kind: 'user', text: 'Hi <b>there</b>', createdAt: iso(30000) }] })],
    [/^\/api\/orders\/(\w+)$/, (m) => ({ order: Object.assign({}, orders.find((o) => o.id === m[1]), { viewerRole: role }) })],
    [/^\/api\/orders/, () => ({ orders: orders.map((o) => Object.assign({}, o, { viewerRole: role })) })],
    [/^\/api\/disputes\/d1$/, () => ({ dispute })],
    [/^\/api\/disputes/, () => ({ disputes: [dispute] })],
    [/^\/api\/admin\/kyc/, () => ({ users: [{ id: 'u9', name: 'New Person', email: 'n@example.test', role: 'buyer', kyc: { status: 'pending', legalName: 'NEW PERSON' }, submittedAt: iso(60000), panLast4: 'ABCD' }] })],
    [/^\/api\/admin\/payment-accounts/, () => ({ accounts: [{ userId: 'm1', name: 'Meera Nair', kycLegalName: 'MEERA NAIR', upi: 'new@okhdfcbank', submittedAt: iso(60000) }] })],
    [/^\/api\/admin\/disputes/, () => ({ disputes: [dispute] })],
    [/^\/api\/admin\/users/, () => ({ users: [users.merchant, users.buyer] })]
  ];
  const fetchStub = async (url) => {
    const r = routes.find(([re]) => re.test(url));
    if (!r) return { ok: false, status: 404, json: async () => ({ error: 'no route ' + url }) };
    return { ok: true, status: 200, json: async () => r[1](url.match(r[0])) };
  };

  const store = { md_token: 'fake-token' };
  const sandbox = {
    console, document: doc, fetch: fetchStub, URL, FormData: class {}, Promise, Date, Math, Number, String, Object, Array, JSON, isFinite, encodeURIComponent,
    navigator: {}, window: { addEventListener() {}, open: () => null },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}
  };
  return { sandbox, el, listeners };
}

async function click(env, dataset) {
  const btn = { dataset, disabled: false };
  for (const fn of env.listeners.click) fn({ target: { closest: () => btn } });
  await sleep();
}

for (const role of ['merchant', 'buyer', 'admin']) {
  test(`${role}: every screen renders without errors`, async () => {
    const env = makeEnv(role);
    vm.runInNewContext(code, env.sandbox);
    await sleep(40);
    const view = () => env.el('#view').innerHTML;
    const toast = () => env.el('#toast').textContent;

    assert.ok(view().length > 100, 'first screen rendered');
    assert.equal(toast(), '', 'no error on first screen');

    const tabs = role === 'admin' ? ['kyc', 'accounts', 'disputes', 'users'] : ['home', 'orders', 'chats', 'disputes', 'account'];
    for (const t of tabs) {
      env.el('#toast').textContent = '';
      await click(env, { a: 'tab', t });
      assert.equal(toast(), '', `tab ${t}: ${toast()}`);
      assert.ok(view().length > 40, `tab ${t} has content`);
    }

    if (role !== 'admin') {
      for (const id of ['o0', 'o1', 'o2', 'o3', 'o4']) {
        env.el('#toast').textContent = '';
        await click(env, { a: 'tab', t: 'orders' });
        await click(env, { a: 'open-order', id });
        assert.equal(toast(), '', `order ${id}: ${toast()}`);
        assert.match(view(), /Progress/, `order ${id} shows progress`);
        await click(env, { a: 'open-chat', id });
        assert.equal(toast(), '', `chat ${id}: ${toast()}`);
        assert.ok(view().includes('Hi &lt;b&gt;there&lt;/b&gt;'), 'chat text is escaped');
      }
      await click(env, { a: 'tab', t: 'orders' });
      await click(env, { a: 'open-order', id: 'o1' });
      await click(env, { a: 'new-dispute', id: 'o1' });
      assert.equal(toast(), '', 'new dispute form: ' + toast());
      assert.match(view(), /Open dispute/);
    }
    if (role === 'merchant') {
      await click(env, { a: 'tab', t: 'account' });
      await click(env, { a: 'replace-account' });
      assert.equal(toast(), '', 'replace account: ' + toast());
    }
    // a dispute screen
    env.el('#toast').textContent = '';
    await click(env, { a: 'tab', t: 'disputes' });
    await click(env, { a: 'open-dispute', id: 'd1' });
    assert.equal(toast(), '', 'dispute detail: ' + toast());
    assert.match(view(), /What happened/);
    if (role === 'admin') assert.match(view(), /Resolve dispute/);
  });
}

test('signed-out visitors get the sign-in screen', async () => {
  const env = makeEnv('merchant');
  env.sandbox.localStorage.removeItem('md_token');
  vm.runInNewContext(code, env.sandbox);
  await sleep(40);
  assert.match(env.el('#view').innerHTML, /Create account/);
  assert.match(env.el('#view').innerHTML, /id="auth-form"/);
});

test('logging out from the profile clears token and displays sign-in screen', async () => {
  const env = makeEnv('buyer');
  vm.runInNewContext(code, env.sandbox);
  await sleep(40);
  assert.equal(env.sandbox.localStorage.getItem('md_token'), 'fake-token');

  // Go to profile and click logout
  await click(env, { a: 'tab', t: 'account' });
  assert.match(env.el('#view').innerHTML, /Profile session/);
  await click(env, { a: 'logout' });

  assert.equal(env.sandbox.localStorage.getItem('md_token'), null);
  assert.match(env.el('#view').innerHTML, /Create account/);
  assert.match(env.el('#view').innerHTML, /id="auth-form"/);
  assert.equal(env.el('#toast').textContent, 'Signed out');
});

