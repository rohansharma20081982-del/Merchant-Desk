/* USDT Merchant Desk: mobile web client for the API in ../src.
   One page, three roles: merchant (sells USDT), buyer (buys USDT), admin (support). */
(function () {
'use strict';

/* ---------- helpers ---------- */
var $ = function (s) { return document.querySelector(s); };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
var KEY = 'md_token';
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
var fmtInr = function (n) { return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
var fmtU = function (n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
function ago(t) {
  var s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return 'just now';
  var m = Math.floor(s / 60); if (m < 60) return m + ' min ago';
  var h = Math.floor(m / 60); if (h < 24) return h + ' h ago';
  var d = Math.floor(h / 24); return d === 1 ? 'Yesterday' : d + ' days ago';
}
function clock(t) { return new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); }
function initials(n) { return String(n || '?').split(' ').map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase(); }
function pad(n) { return String(n).padStart(2, '0'); }

/* ---------- state ---------- */
var S = { token: null, me: null, socket: null, cfg: { rate: 109, limits: { minInr: 500, maxInr: 100000 }, paymentWindowMinutes: 15 } };
function blank() {
  return { orders: [], disputes: [], stats: null, merchants: null, buyUsdt: '', order: null, dispute: null,
    msgs: {}, unread: {}, joined: {}, admin: { kyc: [], accounts: [], disputes: [], users: [] } };
}
var D = blank();
var V = { tab: null, sub: null, stack: [], filter: 'all', authMode: 'login', dstatus: 'review', busy: false };

var ST = {
  awaiting_payment: { l: 'Awaiting payment', c: 'warn' },
  paid: { l: 'Payment marked', c: 'info' },
  completed: { l: 'Completed', c: 'good' },
  disputed: { l: 'Disputed', c: 'bad' },
  cancelled: { l: 'Cancelled', c: 'mute' }
};
var RS = {
  payment_not_received: 'Payment not received',
  wrong_amount: 'Wrong amount received',
  payer_name_mismatch: 'Payer name does not match',
  other: 'Something else'
};
var KYC = { none: ['mute', 'Not verified'], pending: ['warn', 'In review'], verified: ['good', 'Verified'], rejected: ['bad', 'Rejected'] };

var I = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5h4v5"/>',
  orders: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M9 8.5h6M9 12.5h6M9 16.5h3.5"/>',
  chat: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
  dispute: '<path d="M12 3.5 3 19.5h18z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  check: '<path d="m5.5 12.5 4 4L18.5 8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  send: '<path d="M4 12 20 4l-5 16-3.5-6.5z"/>',
  back: '<path d="M14.5 5 7.5 12l7 7"/>',
  clip: '<path d="M19 11.5 11.5 19a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'
};
function ic(n, s) {
  s = s || 22;
  return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[n] + '</svg>';
}
function pill(c, t, dot) { return '<span class="pill ' + c + '">' + (dot ? '<i></i>' : '') + esc(t) + '</span>'; }

/* ---------- api ---------- */
async function api(method, path, body, isForm) {
  var opts = { method: method, headers: {} };
  if (S.token) opts.headers.Authorization = 'Bearer ' + S.token;
  if (body !== undefined && body !== null) {
    if (isForm) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  var res;
  try { res = await fetch('/api' + path, opts); }
  catch (e) { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  var j = {};
  try { j = await res.json(); } catch (e) {}
  if (res.status === 401 && S.token && path.indexOf('/auth/') !== 0) { logout(); throw new Error(j.error || 'Please sign in again'); }
  if (!res.ok) { var err = new Error(j.error || 'Something went wrong'); err.fields = j.fields; err.status = res.status; throw err; }
  return j;
}
function fieldMsg(e) {
  if (e && e.fields && e.fields.length) return e.fields.map(function (f) { return f.message; }).join('. ');
  return (e && e.message) || 'Something went wrong';
}
var tt;
function toast(m) {
  var e = $('#toast'); e.textContent = m; e.classList.add('show');
  clearTimeout(tt); tt = setTimeout(function () { e.classList.remove('show'); }, 3000);
}
async function run(fn) {
  if (V.busy) return;
  V.busy = true;
  try { await fn(); } catch (e) { toast(fieldMsg(e)); } finally { V.busy = false; }
}

/* ---------- realtime ---------- */
function connectSocket() {
  if (S.socket || typeof io !== 'function') return;
  S.socket = io({ auth: function (cb) { cb({ token: S.token }); } });
  S.socket.on('connect', function () {
    D.joined = {}; joinRooms();
    if (V.sub && V.sub.k === 'chat') joinRoom(V.sub.id);
  });
  S.socket.on('chat:message', onChatMessage);
  S.socket.on('order:updated', function () { scheduleRefresh(); });
  S.socket.on('order:new', function () { toast('You have a new order'); });
  S.socket.on('order:paid', function () { toast('A buyer marked an order as paid'); });
}
function joinRoom(id) {
  if (!S.socket || D.joined[id]) return;
  D.joined[id] = true;
  S.socket.emit('order:join', id, function (r) { if (!r || !r.ok) D.joined[id] = false; });
}
function joinRooms() {
  D.orders.forEach(function (o) { if (o.status !== 'completed' && o.status !== 'cancelled') joinRoom(o.id); });
}
function pushMsg(m) {
  var list = D.msgs[m.order] = D.msgs[m.order] || [];
  if (!list.some(function (x) { return x.id === m.id; })) list.push(m);
}
function onChatMessage(m) {
  pushMsg(m);
  if (V.sub && V.sub.k === 'chat' && V.sub.id === m.order) { renderMsgs(); return; }
  if (m.sender !== S.me.id && m.kind === 'user') { D.unread[m.order] = true; toast('New message'); softRender(); }
}
var rtimer = null;
function scheduleRefresh() { clearTimeout(rtimer); rtimer = setTimeout(refreshQuiet, 350); }
async function refreshQuiet() {
  if (!S.me) return;
  try {
    await refreshMe();
    if (S.me.role !== 'admin') D.orders = (await api('GET', '/orders?limit=100')).orders;
    if (V.sub) await loadSub(V.sub); else await loadTab(V.tab, true);
    joinRooms();
  } catch (e) { /* stay on the current screen */ }
  if (V.sub && V.sub.k === 'chat') { header(); nav(); renderMsgs(); } else softRender();
}

/* ---------- loading ---------- */
async function refreshMe() { S.me = (await api('GET', '/me')).user; }
async function loadOrders() { D.orders = (await api('GET', '/orders?limit=100')).orders; joinRooms(); }

async function loadTab(tab, skipOrders) {
  var role = S.me.role;
  if (role === 'admin') {
    if (tab === 'kyc') D.admin.kyc = (await api('GET', '/admin/kyc')).users;
    if (tab === 'accounts') D.admin.accounts = (await api('GET', '/admin/payment-accounts')).accounts;
    if (tab === 'disputes') D.admin.disputes = (await api('GET', '/admin/disputes?status=' + V.dstatus)).disputes;
    if (tab === 'users') D.admin.users = (await api('GET', '/admin/users')).users;
    return;
  }
  var needsOrders = tab === 'home' || tab === 'orders' || tab === 'chats' || tab === 'disputes';
  if (needsOrders && !skipOrders) await loadOrders();
  if (tab === 'home' && role === 'merchant') D.stats = await api('GET', '/me/stats');
  if (tab === 'disputes') D.disputes = (await api('GET', '/disputes')).disputes;
}
async function loadSub(s) {
  if (s.k === 'order' || s.k === 'new-dispute') {
    D.order = (await api('GET', '/orders/' + s.id)).order;
    if (s.k === 'order' && S.me.role !== 'admin') D.disputes = (await api('GET', '/disputes')).disputes;
  } else if (s.k === 'chat') {
    D.order = (await api('GET', '/orders/' + s.id)).order;
    D.msgs[s.id] = (await api('GET', '/orders/' + s.id + '/messages?limit=100')).messages;
    delete D.unread[s.id];
    joinRoom(s.id);
  } else if (s.k === 'dispute') {
    D.dispute = (await api('GET', '/disputes/' + s.id)).dispute;
    s.orderId = D.dispute.orderId;
    D.order = (await api('GET', '/orders/' + s.orderId)).order;
    if (S.me.role === 'admin') D.msgs[s.orderId] = (await api('GET', '/orders/' + s.orderId + '/messages?limit=100')).messages;
  }
}

async function go(tab) {
  V.tab = tab; V.sub = null; V.stack = [];
  try { await loadTab(tab); if (tab === 'account' || tab === 'home') await refreshMe(); } catch (e) { toast(fieldMsg(e)); }
  render(true);
}
async function open(sub) {
  var prev = V.sub;
  try { await loadSub(sub); } catch (e) { toast(fieldMsg(e)); return; }
  if (prev) V.stack.push(prev);
  V.sub = sub;
  render(true);
}
async function back() {
  var prev = V.stack.pop() || null;
  V.sub = prev;
  try { if (prev) await loadSub(prev); else await loadTab(V.tab); } catch (e) { toast(fieldMsg(e)); }
  render(true);
}

/* ---------- small view helpers ---------- */
function cp(o) { return S.me.role === 'merchant' ? o.buyer.name : o.merchant.name; }
function cd(o) {
  var s = Math.max(0, Math.floor((new Date(o.expiresAt).getTime() - Date.now()) / 1000));
  return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
}
function field(id, label, type, ac, extra) {
  return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="' + type + '" autocomplete="' + ac + '" ' + (extra || '') + '></div>';
}
function copyBtn(v) { return '<button type="button" class="copy" data-a="copy" data-v="' + esc(v) + '">Copy</button>'; }
function gateReason(me) {
  if (me.kyc.status !== 'verified') return 'Verify your identity to go online.';
  if (!me.paymentAccount) return 'Add your payment account to go online.';
  if (me.pendingPaymentAccount) return 'Your new payment account is being verified.';
  return null;
}

function orderRow(o) {
  var st = ST[o.status], who = cp(o);
  return '<button class="row" data-a="open-order" data-id="' + o.id + '"><span class="av">' + initials(who) + '</span>'
    + '<span class="mid"><b>' + esc(who) + '</b><span>#' + esc(o.ref) + ' · ' + ago(o.createdAt) + '</span></span>'
    + '<span class="end"><b class="num">' + fmtInr(o.inr) + '</b>' + pill(st.c, st.l) + '</span></button>';
}

function hero(label, big, a, aLbl, b, bLbl) {
  return '<section class="hero"><div class="lbl">' + label + '</div><div class="big num">' + fmtU(big) + '<small>USDT</small></div>'
    + (aLbl ? '<div class="hero-grid"><div><b>' + fmtU(a) + '</b><span>' + aLbl + '</span></div><div><b>' + fmtU(b) + '</b><span>' + bLbl + '</span></div></div>' : '')
    + '<span class="rate num">1 USDT = ₹' + Number(S.cfg.rate).toFixed(2) + '</span></section>';
}

/* ---------- views: sign in ---------- */
function authView() {
  var reg = V.authMode === 'register';
  return '<div class="auth">'
    + '<div class="logo xl" aria-hidden="true">₮</div><h1>USDT Merchant Desk</h1>'
    + '<p class="muted" style="margin:0">Trade USDT for rupees with escrow, verified accounts and live chat.</p>'
    + '<div class="seg" role="tablist"><button type="button" role="tab" aria-selected="' + !reg + '" data-a="auth-mode" data-m="login">Sign in</button>'
    + '<button type="button" role="tab" aria-selected="' + reg + '" data-a="auth-mode" data-m="register">Create account</button></div>'
    + '<form id="auth-form" class="stack" novalidate>'
    + (reg ? field('a-name', 'Full name', 'text', 'name') : '')
    + field('a-email', 'Email', 'email', 'email', 'inputmode="email" autocapitalize="off"')
    + field('a-pass', 'Password' + (reg ? ' (10 or more characters)' : ''), 'password', reg ? 'new-password' : 'current-password')
    + (reg ? '<div class="opts" role="radiogroup" aria-label="Account type">'
      + '<label class="opt"><input type="radio" name="role" value="buyer" checked><b>I buy USDT</b><span>Pay rupees, receive USDT</span></label>'
      + '<label class="opt"><input type="radio" name="role" value="merchant"><b>I sell USDT</b><span>Receive rupees, release USDT</span></label></div>' : '')
    + '<p class="err" id="auth-err" role="alert"></p>'
    + '<button class="btn primary" type="submit">' + (reg ? 'Create account' : 'Sign in') + '</button></form></div>';
}

/* ---------- views: home ---------- */
function merchantHome() {
  var me = S.me, b = me.balance, gate = gateReason(me);
  var act = D.orders.filter(function (o) { return o.status === 'paid'; });
  var st = D.stats || { today: { completed: 0, volumeInr: 0 }, completionRate: 100, openDisputes: 0 };
  var on = me.online && !gate;
  var h = '<div class="stack">';
  h += hero('Total USDT', b.available + b.escrow, b.available, 'Available', b.escrow, 'In escrow');
  h += '<section class="card toggle"><div><b>' + (on ? 'Receiving orders' : 'Not receiving orders') + '</b><span class="muted small">'
    + esc(gate || (on ? 'Verified buyers can place orders against your balance.' : 'Turn on to start receiving buyer orders.')) + '</span></div>'
    + '<button class="switch" role="switch" aria-label="Receive orders" aria-checked="' + on + '" data-a="toggle-online"' + (gate ? ' disabled' : '') + '></button></section>';
  if (gate) h += '<button class="btn gold" data-a="tab" data-t="account">Finish setup</button>';
  if (act.length) {
    h += '<section class="sec"><h2>Needs your action</h2><div class="list">' + act.map(orderRow).join('') + '</div>'
      + '<p class="muted small" style="margin:0">Check your bank app. Release the USDT only after the full amount has arrived from the buyer’s own account.</p></section>';
  }
  h += '<section class="sec"><h2>Today</h2><div class="stats">'
    + '<div class="stat"><span>Completed</span><b class="num">' + st.today.completed + '</b></div>'
    + '<div class="stat"><span>Volume</span><b class="num">' + fmtInr(st.today.volumeInr) + '</b></div>'
    + '<div class="stat"><span>Completion rate</span><b class="num">' + st.completionRate + '%</b></div>'
    + '<div class="stat"><span>Open disputes</span><b class="num">' + st.openDisputes + '</b></div></div></section>';
  h += '<section class="sec"><div class="sec-head"><h2>Recent orders</h2><button class="link" data-a="tab" data-t="orders">See all</button></div>'
    + (D.orders.length ? '<div class="list">' + D.orders.slice(0, 4).map(orderRow).join('') + '</div>' : '<div class="card empty">No orders yet. They show up here when you are online.</div>') + '</section>';
  return h + '</div>';
}

function buyerHome() {
  var me = S.me, ver = me.kyc.status === 'verified';
  var act = D.orders.filter(function (o) { return o.status === 'awaiting_payment'; });
  var h = '<div class="stack">';
  h += hero('Your USDT', me.balance.available);
  if (!ver) {
    var k = me.kyc.status;
    h += '<section class="note ' + (k === 'rejected' ? 'bad' : '') + '"><span>' + ic('shield', 20) + '</span><span>'
      + (k === 'pending' ? 'Your identity check is in review. You can buy once it is approved.'
        : k === 'rejected' ? 'Your identity check was rejected: ' + esc(me.kyc.rejectReason || 'please resubmit') + '.'
          : 'Verify your identity before you buy. Payments must come from an account in your own name.') + '</span></section>';
    if (k !== 'pending') h += '<button class="btn gold" data-a="tab" data-t="account">Verify identity</button>';
  } else {
    h += '<section class="card stack" style="gap:12px"><h2>Buy USDT</h2>'
      + '<div class="field"><label for="buy-usdt">How many USDT?</label><input class="input" id="buy-usdt" inputmode="decimal" autocomplete="off" placeholder="For example 50" value="' + esc(D.buyUsdt) + '"></div>'
      + '<p class="est" id="est">' + estimate(D.buyUsdt) + '</p>'
      + '<button class="btn primary" data-a="find">Find merchants</button></section>';
    if (D.merchants) {
      h += '<section class="sec"><h2>Available merchants</h2>' + (D.merchants.length
        ? '<div class="list">' + D.merchants.map(function (m) {
          return '<div class="row"><span class="av">' + initials(m.name) + '</span><span class="mid"><b>' + esc(m.name) + '</b><span>' + fmtU(m.availableUsdt) + ' USDT available</span></span>'
            + '<button class="btn gold sm" data-a="buy" data-id="' + m.id + '">Buy</button></div>';
        }).join('') + '</div>'
        : '<div class="card empty">No merchant can fill this amount right now. Try a smaller amount.</div>') + '</section>';
    }
  }
  if (act.length) h += '<section class="sec"><h2>Waiting for your payment</h2><div class="list">' + act.map(orderRow).join('') + '</div></section>';
  h += '<section class="sec"><div class="sec-head"><h2>Recent orders</h2><button class="link" data-a="tab" data-t="orders">See all</button></div>'
    + (D.orders.length ? '<div class="list">' + D.orders.slice(0, 4).map(orderRow).join('') + '</div>' : '<div class="card empty">Your orders will show up here.</div>') + '</section>';
  return h + '</div>';
}
function estimate(v) {
  var n = Number(v);
  if (!v || !isFinite(n) || n <= 0) return '';
  var inr = n * S.cfg.rate, l = S.cfg.limits;
  if (inr < l.minInr || inr > l.maxInr) return 'You would pay ' + fmtInr(inr) + '. Orders must be between ' + fmtInr(l.minInr) + ' and ' + fmtInr(l.maxInr) + '.';
  return 'You would pay ' + fmtInr(inr) + ' at ₹' + Number(S.cfg.rate).toFixed(2) + ' per USDT.';
}

/* ---------- views: orders, chats, disputes ---------- */
function ordersView() {
  var f = V.filter;
  var m = {
    all: function () { return true; },
    open: function (o) { return o.status === 'awaiting_payment' || o.status === 'paid'; },
    closed: function (o) { return o.status === 'completed' || o.status === 'cancelled'; },
    disputed: function (o) { return o.status === 'disputed'; }
  };
  var list = D.orders.filter(m[f]);
  var chips = [['all', 'All'], ['open', 'Open'], ['closed', 'Closed'], ['disputed', 'Disputed']].map(function (c) {
    return '<button class="chip" aria-pressed="' + (f === c[0]) + '" data-a="filter" data-f="' + c[0] + '">' + c[1] + '</button>';
  }).join('');
  return '<div class="stack"><div class="chips" role="group" aria-label="Filter orders">' + chips + '</div>'
    + (list.length ? '<div class="list">' + list.map(orderRow).join('') + '</div>' : '<div class="card empty">No orders in this view.</div>') + '</div>';
}

function chatsView() {
  if (!D.orders.length) return '<div class="card empty">Each order has its own chat. None yet.</div>';
  return '<div class="stack"><div class="list">' + D.orders.map(function (o) {
    var st = ST[o.status];
    return '<button class="row" data-a="open-chat" data-id="' + o.id + '"><span class="av">' + initials(cp(o)) + '</span>'
      + '<span class="mid"><b>' + esc(cp(o)) + '</b><span>Order #' + esc(o.ref) + ' · ' + fmtU(o.usdt) + ' USDT</span></span>'
      + '<span class="end">' + (D.unread[o.id] ? '<i class="dot" aria-label="Unread messages"></i>' : '') + pill(st.c, st.l) + '</span></button>';
  }).join('') + '</div></div>';
}

function disputesView() {
  var h = '<div class="stack"><section class="card stack" style="gap:10px"><h2>How disputes work</h2>'
    + '<ol class="small" style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">'
    + '<li>Open a dispute from the order and attach proof such as a bank statement.</li>'
    + '<li>The USDT stays in escrow while the dispute is open.</li>'
    + '<li>Support reviews both sides and releases the USDT to the right person.</li></ol></section>';
  h += D.disputes.length ? '<div class="list">' + D.disputes.map(function (d) {
    var o = D.orders.filter(function (x) { return x.id === d.orderId; })[0];
    return '<button class="row" data-a="open-dispute" data-id="' + d.id + '"><span class="av bad">' + ic('dispute', 20) + '</span>'
      + '<span class="mid"><b>' + esc(d.ref) + (o ? ' · #' + esc(o.ref) : '') + '</b><span>' + esc(RS[d.reason] || d.reason) + '</span></span>'
      + '<span class="end">' + (o ? '<b class="num">' + fmtInr(o.inr) + '</b>' : '') + (d.status === 'resolved' ? pill('good', 'Resolved') : pill('warn', 'Under review')) + '</span></button>';
  }).join('') + '</div>' : '<div class="card empty">You have no disputes.</div>';
  return h + '</div>';
}

/* ---------- views: one order ---------- */
function steps(o) {
  var L, st;
  switch (o.status) {
    case 'awaiting_payment': L = ['Order placed', 'Buyer pays the merchant’s verified account', 'Merchant confirms the money arrived', 'USDT released from escrow']; st = ['done', 'now', 'todo', 'todo']; break;
    case 'paid': L = ['Order placed', 'Buyer marked the payment as sent', 'Merchant confirms the money arrived', 'USDT released from escrow']; st = ['done', 'done', 'now', 'todo']; break;
    case 'completed': L = ['Order placed', 'Buyer paid the merchant’s verified account', 'Merchant confirmed the money arrived', 'USDT released to the buyer']; st = ['done', 'done', 'done', 'done']; break;
    case 'disputed': L = ['Order placed', 'Buyer marked the payment as sent', 'On hold for dispute review', 'USDT released from escrow']; st = ['done', 'done', 'hold', 'todo']; break;
    default: L = ['Order placed', 'Cancelled' + (o.cancelReason ? ': ' + o.cancelReason : '')]; st = ['done', 'stop'];
  }
  return '<ol class="tl">' + L.map(function (t, i) {
    var g = st[i] === 'done' ? ic('check', 14) : (st[i] === 'stop' || st[i] === 'hold') ? ic('x', 14) : '';
    return '<li class="' + st[i] + '"><span class="nd">' + g + '</span><b>' + esc(t) + '</b></li>';
  }).join('') + '</ol>';
}

function orderView() {
  var o = D.order, me = S.me, role = o.viewerRole, st = ST[o.status];
  var dsp = D.disputes.filter(function (x) { return x.orderId === o.id; })[0];
  var h = '<div class="stack">';
  h += '<section class="card sum"><span class="muted small">' + (role === 'buyer' ? 'You pay' : 'Buyer pays') + '</span><div class="big num">' + fmtInr(o.inr) + '</div>'
    + '<div class="muted num">' + fmtU(o.usdt) + ' USDT at ₹' + Number(o.rate).toFixed(2) + '</div>' + pill(st.c, st.l, true) + '</section>';

  if (o.status === 'awaiting_payment') {
    h += role === 'buyer'
      ? '<section class="note"><span>' + ic('clock', 20) + '</span><span>Pay <b class="num">' + fmtInr(o.inr) + '</b> within <b class="num" id="cd">' + cd(o) + '</b> from a bank account in your own name (' + esc(me.kyc.legalName || me.name) + '). Payments from someone else’s account are refused.</span></section>'
      : '<section class="note"><span>' + ic('clock', 20) + '</span><span>Waiting for ' + esc(o.buyer.name) + ' to pay. The order closes in <b class="num" id="cd">' + cd(o) + '</b> and your USDT returns to your balance.</span></section>';
  }
  if (role === 'buyer' && (o.status === 'awaiting_payment' || o.status === 'paid')) {
    h += '<section class="card stack" style="gap:12px"><h2>Pay to this account</h2><dl class="kv">'
      + '<div><dt>UPI ID</dt><dd>' + esc(o.payTo.upi) + copyBtn(o.payTo.upi) + '</dd></div>'
      + '<div><dt>Account holder</dt><dd>' + esc(o.payTo.holderName) + '</dd></div>'
      + '<div><dt>Amount</dt><dd class="num">' + fmtInr(o.inr) + copyBtn(String(o.inr)) + '</dd></div></dl></section>';
  }
  if (role === 'buyer' && o.status === 'awaiting_payment') {
    h += '<form class="card stack" id="paid-form" novalidate><h2>After you have paid</h2>'
      + '<div class="field"><label for="utr">Bank reference (UTR)</label><input class="input" id="utr" maxlength="22" autocomplete="off" autocapitalize="characters" placeholder="6 to 22 letters or digits"></div>'
      + '<button class="btn primary" type="submit">I have paid</button></form>'
      + '<button class="btn ghost" data-a="cancel" data-id="' + o.id + '">Cancel order</button>';
  }
  if (role === 'buyer' && o.status === 'paid') {
    h += '<section class="note info"><span>' + ic('info', 20) + '</span><span>Waiting for ' + esc(o.merchant.name) + ' to confirm. Your USDT is released as soon as the money shows in their account.</span></section>'
      + '<button class="btn danger" data-a="new-dispute" data-id="' + o.id + '">' + ic('dispute', 18) + ' Problem with this order</button>';
  }
  if (role === 'merchant' && o.status === 'paid') {
    h += '<section class="card stack"><h2>Release USDT</h2>'
      + '<p class="small" style="margin:0">Open your bank app and look for <b class="num">' + fmtInr(o.inr) + '</b> from <b>' + esc(o.expectedPayerName || o.buyer.name) + '</b>'
      + (o.utr ? ' (reference <span class="num">' + esc(o.utr) + '</span>)' : '') + '.</p>'
      + '<label class="check"><input type="checkbox" id="ack"><span>I checked my own bank statement. The full amount arrived from an account in the buyer’s name.</span></label>'
      + '<div class="btns"><button class="btn primary" id="rel" data-a="release" data-id="' + o.id + '" disabled>' + ic('lock', 18) + ' Confirm and release ' + fmtU(o.usdt) + ' USDT</button>'
      + '<button class="btn danger" data-a="new-dispute" data-id="' + o.id + '">' + ic('dispute', 18) + ' Money has not arrived, open dispute</button></div></section>';
  }
  if (role === 'merchant' && o.status === 'awaiting_payment') {
    h += '<button class="btn ghost" data-a="cancel" data-id="' + o.id + '">Cancel order</button>';
  }

  h += '<section class="card"><dl class="kv"><div><dt>Order</dt><dd class="num">#' + esc(o.ref) + '</dd></div>'
    + '<div><dt>' + (role === 'merchant' ? 'Buyer' : 'Merchant') + '</dt><dd>' + esc(role === 'merchant' ? o.buyer.name : o.merchant.name) + '</dd></div>'
    + '<div><dt>Placed</dt><dd>' + clock(o.createdAt) + ' · ' + ago(o.createdAt) + '</dd></div>'
    + (o.utr ? '<div><dt>Bank reference</dt><dd class="num">' + esc(o.utr) + '</dd></div>' : '') + '</dl></section>';
  h += '<section class="card stack" style="gap:12px"><h2>Progress</h2>' + steps(o) + '</section>';
  if (dsp) h += '<button class="btn ghost" data-a="open-dispute" data-id="' + dsp.id + '">View dispute ' + esc(dsp.ref) + '</button>';
  h += '<button class="btn gold" data-a="open-chat" data-id="' + o.id + '">' + ic('chat', 18) + ' Chat with ' + esc(role === 'merchant' ? o.buyer.name : o.merchant.name) + '</button>';
  return h + '</div>';
}

function msgHTML(m) {
  var kind = m.kind === 'system' ? 'sys' : (m.sender === S.me.id ? 'me' : 'them');
  return '<div class="bub ' + kind + '">' + esc(m.text) + (kind === 'sys' ? '' : '<small>' + clock(m.createdAt) + '</small>') + '</div>';
}
function chatView() {
  var list = D.msgs[V.sub.id] || [];
  return '<div class="chat-wrap"><div class="note info" style="margin-top:4px"><span>' + ic('shield', 20) + '</span><span>Keep the conversation here. Never share a UPI PIN, OTP or card details, and never release USDT for a payment you have not seen in your own account.</span></div>'
    + '<div class="msgs" id="msgs">' + (list.map(msgHTML).join('') || '<p class="empty">No messages yet.</p>') + '</div>'
    + '<form class="composer" id="chat-form" autocomplete="off"><input class="input" id="msg" aria-label="Message" placeholder="Write a message" maxlength="500"><button class="send" type="submit" aria-label="Send">' + ic('send', 20) + '</button></form></div>';
}
function renderMsgs() {
  var box = $('#msgs');
  if (!box || !V.sub || V.sub.k !== 'chat') return;
  var list = D.msgs[V.sub.id] || [];
  box.innerHTML = list.map(msgHTML).join('') || '<p class="empty">No messages yet.</p>';
  var v = $('#view'); v.scrollTop = v.scrollHeight;
}

/* ---------- views: disputes ---------- */
function fileList(d) {
  if (!d.files.length) return '<p class="muted small" style="margin:0">No files attached.</p>';
  return '<ul class="files">' + d.files.map(function (f) {
    return '<li>' + ic('clip', 16) + '<button type="button" data-a="open-file" data-d="' + d.id + '" data-n="' + esc(f.name) + '">' + esc(f.originalName || f.name) + '</button></li>';
  }).join('') + '</ul>';
}
function disputeView() {
  var d = D.dispute, o = D.order, res = d.status === 'resolved', admin = S.me.role === 'admin';
  var L = ['Dispute opened', 'Under review by support', res ? 'Resolved: ' + (d.resolution.outcome === 'release_to_buyer' ? 'USDT released to the buyer' : 'USDT returned to the merchant') : 'Decision'];
  var st = res ? ['done', 'done', 'done'] : ['done', 'now', 'todo'];
  var h = '<div class="stack">';
  h += '<section class="card"><dl class="kv"><div><dt>Order</dt><dd class="num">#' + esc(o.ref) + '</dd></div>'
    + '<div><dt>Merchant</dt><dd>' + esc(o.merchant.name) + '</dd></div><div><dt>Buyer</dt><dd>' + esc(o.buyer.name) + '</dd></div>'
    + '<div><dt>Amount held</dt><dd class="num">' + fmtU(o.usdt) + ' USDT</dd></div><div><dt>Rupees</dt><dd class="num">' + fmtInr(o.inr) + '</dd></div>'
    + (o.utr ? '<div><dt>Bank reference</dt><dd class="num">' + esc(o.utr) + '</dd></div>' : '')
    + '<div><dt>Opened</dt><dd>' + ago(d.createdAt) + '</dd></div><div><dt>Reason</dt><dd>' + esc(RS[d.reason] || d.reason) + '</dd></div></dl></section>';
  h += '<section class="card stack" style="gap:8px"><h2>What happened</h2><p style="margin:0;overflow-wrap:anywhere">' + esc(d.details) + '</p>' + fileList(d) + '</section>';
  h += '<section class="card stack" style="gap:12px"><h2>Status</h2><ol class="tl">' + L.map(function (t, i) {
    return '<li class="' + st[i] + '"><span class="nd">' + (st[i] === 'done' ? ic('check', 14) : '') + '</span><b>' + esc(t) + '</b></li>';
  }).join('') + '</ol>' + (res && d.resolution.note ? '<p class="small muted" style="margin:0">Support note: ' + esc(d.resolution.note) + '</p>' : '')
    + (!res && !admin ? '<p class="muted small" style="margin:0">Support replies within 24 hours. The USDT stays in escrow until then.</p>' : '') + '</section>';
  if (admin) {
    var msgs = D.msgs[o.id] || [];
    h += '<section class="card stack" style="gap:8px"><h2>Chat between the two sides</h2><div class="transcript">'
      + (msgs.length ? msgs.map(function (m) {
        var who = m.kind === 'system' ? 'System' : (m.sender === o.merchant.id ? 'Merchant' : m.sender === o.buyer.id ? 'Buyer' : 'Support');
        return '<p><b>' + who + ':</b> ' + esc(m.text) + '</p>';
      }).join('') : '<p class="muted">No messages.</p>') + '</div></section>';
    if (!res) {
      h += '<form class="card stack" id="resolve-form" novalidate><h2>Decision</h2>'
        + '<p class="muted small" style="margin:0">Release to the buyer only if the merchant’s statement shows the money, or the merchant cannot show it did not arrive.</p>'
        + '<div class="field"><label for="res-outcome">Outcome</label><select class="input" id="res-outcome"><option value="release_to_buyer">Release USDT to the buyer</option><option value="return_to_merchant">Return USDT to the merchant</option></select></div>'
        + '<div class="field"><label for="res-note">Note for both sides</label><textarea class="input" id="res-note" maxlength="1000" placeholder="Why you decided this"></textarea></div>'
        + '<button class="btn primary" type="submit">Resolve dispute</button></form>';
    }
  } else {
    h += '<button class="btn gold" data-a="open-chat" data-id="' + o.id + '">' + ic('chat', 18) + ' Open chat</button>';
  }
  return h + '</div>';
}

function newDisputeView() {
  var o = D.order;
  return '<form class="stack" id="dispute-form" novalidate><section class="card"><dl class="kv"><div><dt>Order</dt><dd class="num">#' + esc(o.ref) + '</dd></div>'
    + '<div><dt>Amount held</dt><dd class="num">' + fmtU(o.usdt) + ' USDT</dd></div></dl></section>'
    + '<div class="field"><label for="d-reason">What went wrong?</label><select class="input" id="d-reason">'
    + Object.keys(RS).map(function (k) { return '<option value="' + k + '">' + RS[k] + '</option>'; }).join('') + '</select></div>'
    + '<div class="field"><label for="d-details">Describe what happened</label><textarea class="input" id="d-details" maxlength="2000" placeholder="Include the time you checked your account and what you saw."></textarea></div>'
    + '<div class="field"><label for="d-files">Proof (JPG, PNG, WebP or PDF, up to 5 files)</label><input class="input" id="d-files" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"><ul class="files" id="d-list"></ul></div>'
    + '<div class="btns"><button class="btn danger" type="submit">Open dispute</button><button class="btn ghost" type="button" data-a="back">Cancel</button></div></form>';
}

/* ---------- views: account ---------- */
function kycForm() {
  return '<form class="stack" id="kyc-form" novalidate>'
    + '<div class="field"><label for="k-name">Legal name as on your PAN</label><input class="input" id="k-name" autocomplete="name" maxlength="80"></div>'
    + '<div class="field"><label for="k-pan">Last 4 characters of your PAN</label><input class="input" id="k-pan" maxlength="4" autocapitalize="characters" autocomplete="off"></div>'
    + '<button class="btn primary" type="submit">Submit for verification</button></form>';
}
function upiForm(label) {
  return '<form class="stack" id="upi-form" novalidate><div class="field"><label for="upi">UPI ID</label><input class="input" id="upi" inputmode="email" autocapitalize="off" autocomplete="off" placeholder="name@bank"></div>'
    + '<button class="btn primary" type="submit">' + label + '</button></form>';
}
function accountView() {
  var me = S.me, k = (me.kyc && me.kyc.status) || 'none', kc = KYC[k] || KYC.none;
  var h = '<div class="stack">';
  h += '<section class="card" style="display:flex;gap:14px;align-items:center"><span class="av" style="width:52px;height:52px;font-size:18px">' + initials(me.name) + '</span>'
    + '<div style="min-width:0;flex:1"><b style="font-size:17px">' + esc(me.name) + '</b><div class="muted small" style="overflow-wrap:anywhere">' + esc(me.email) + ' · ' + (me.role === 'merchant' ? 'Merchant' : me.role === 'buyer' ? 'Buyer' : 'Support') + '</div></div>'
    + (me.role !== 'admin' ? pill(kc[0], kc[1], true) : pill('info', 'Support')) + '</section>';
  if (me.role !== 'admin') {
    h += '<section class="card stack" style="gap:12px"><h2>Identity verification</h2>';
    if (k === 'verified') h += '<div class="note good"><span>' + ic('shield', 20) + '</span><span>Verified as <b>' + esc(me.kyc.legalName) + '</b>. Your payment account must be in this name.</span></div>';
    else if (k === 'pending') h += '<div class="note"><span>' + ic('clock', 20) + '</span><span>Your details are in review. This usually takes a short while.</span></div>';
    else {
      if (k === 'rejected') h += '<div class="note bad"><span>' + ic('x', 20) + '</span><span>Rejected: ' + esc(me.kyc.rejectReason || 'please check your details') + '. You can submit again.</span></div>';
      h += kycForm();
    }
    h += '</section>';
  }
  if (me.role === 'merchant') {
    h += '<section class="card stack" style="gap:12px"><h2>Payment account</h2>';
    if (k !== 'verified') h += '<p class="muted small" style="margin:0">You can add your payment account after your identity is verified.</p>';
    else if (me.pendingPaymentAccount) h += '<div class="note"><span>' + ic('clock', 20) + '</span><span>Checking <b>' + esc(me.pendingPaymentAccount.upi) + '</b>. The holder name must match your verified name. You cannot go online until it is approved.</span></div>';
    else if (me.paymentAccount) {
      var a = me.paymentAccount;
      h += '<dl class="kv"><div><dt>UPI ID</dt><dd>' + esc(a.upi) + '</dd></div><div><dt>Holder name</dt><dd>' + esc(a.holderName) + '</dd></div><div><dt>Verified</dt><dd>' + new Date(a.verifiedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '</dd></div></dl>'
        + '<p class="muted small" style="margin:0">Each merchant has one payment account, in their own name. Rotating or sharing accounts is not allowed.</p>'
        + '<button class="btn ghost" data-a="replace-account">Replace account</button>';
    } else h += '<p class="muted small" style="margin:0">Add the one UPI ID you will receive payments on. It must be in your own name.</p>' + upiForm('Send for verification');
    h += '</section>';
  }
  var l = S.cfg.limits;
  h += '<section class="card"><h2 style="margin-bottom:12px">Limits</h2><dl class="kv"><div><dt>Per order</dt><dd class="num">' + fmtInr(l.minInr) + ' to ' + fmtInr(l.maxInr) + '</dd></div>'
    + (l.dailyInr ? '<div><dt>Per merchant per day</dt><dd class="num">' + fmtInr(l.dailyInr) + '</dd></div>' : '')
    + '<div><dt>Payment window</dt><dd class="num">' + S.cfg.paymentWindowMinutes + ' min</dd></div></dl></section>';
  h += '<section class="card stack" style="gap:12px">'
    + '<div class="sec-head"><h2>Profile session</h2><span class="muted small">' + esc(me.email) + '</span></div>'
    + '<p class="muted small" style="margin:0">Signed in as <b>' + esc(me.name) + '</b> (' + (me.role === 'merchant' ? 'Merchant' : me.role === 'buyer' ? 'Buyer' : 'Support') + '). Tap below to securely log out.</p>'
    + '<button class="btn danger" data-a="logout" id="logout-btn">' + ic('logout', 18) + '<span>Log out</span></button>'
    + '</section>';
  return h + '</div>';
}
function replaceView() {
  return '<div class="stack"><div class="note"><span>' + ic('info', 20) + '</span><span>You can have one payment account. The new account replaces the current one after support checks that the holder name matches your verified identity. Open orders keep using the current account. You go offline until it is approved.</span></div>'
    + upiForm('Send for verification') + '<button class="btn ghost" data-a="back">Cancel</button></div>';
}

/* ---------- views: support (admin) ---------- */
function adminKyc() {
  var l = D.admin.kyc;
  if (!l.length) return '<div class="card empty">No identity checks waiting.</div>';
  return '<div class="stack">' + l.map(function (u) {
    return '<section class="card stack" style="gap:10px"><div class="sec-head"><h2>' + esc(u.name) + '</h2>' + pill('info', u.role) + '</div>'
      + '<dl class="kv"><div><dt>Email</dt><dd>' + esc(u.email) + '</dd></div><div><dt>Legal name</dt><dd>' + esc(u.kyc.legalName) + '</dd></div>'
      + '<div><dt>PAN ends</dt><dd class="num">' + esc(u.panLast4) + '</dd></div><div><dt>Submitted</dt><dd>' + ago(u.submittedAt) + '</dd></div></dl>'
      + '<div class="field"><label for="r-' + u.id + '">Reason (needed to reject)</label><input class="input" id="r-' + u.id + '" maxlength="300"></div>'
      + '<div class="btns row2"><button class="btn primary" data-a="kyc-approve" data-id="' + u.id + '">Approve</button><button class="btn danger" data-a="kyc-reject" data-id="' + u.id + '">Reject</button></div></section>';
  }).join('') + '</div>';
}
function adminAccounts() {
  var l = D.admin.accounts;
  if (!l.length) return '<div class="card empty">No payment accounts waiting.</div>';
  return '<div class="stack"><div class="note info"><span>' + ic('info', 20) + '</span><span>Look the UPI ID up with your bank name-lookup service and type the holder name it returns. It must match the verified name.</span></div>' + l.map(function (a) {
    return '<section class="card stack" style="gap:10px"><h2>' + esc(a.name) + '</h2>'
      + '<dl class="kv"><div><dt>Verified name</dt><dd>' + esc(a.kycLegalName) + '</dd></div><div><dt>UPI ID</dt><dd>' + esc(a.upi) + '</dd></div><div><dt>Submitted</dt><dd>' + ago(a.submittedAt) + '</dd></div></dl>'
      + '<div class="field"><label for="h-' + a.userId + '">Holder name from the bank lookup</label><input class="input" id="h-' + a.userId + '" maxlength="80" autocomplete="off"></div>'
      + '<div class="btns row2"><button class="btn primary" data-a="acct-approve" data-id="' + a.userId + '">Approve</button><button class="btn danger" data-a="acct-reject" data-id="' + a.userId + '">Reject</button></div></section>';
  }).join('') + '</div>';
}
function adminDisputes() {
  var chips = [['review', 'Under review'], ['resolved', 'Resolved']].map(function (c) {
    return '<button class="chip" aria-pressed="' + (V.dstatus === c[0]) + '" data-a="dstatus" data-s="' + c[0] + '">' + c[1] + '</button>';
  }).join('');
  var l = D.admin.disputes;
  return '<div class="stack"><div class="chips">' + chips + '</div>' + (l.length ? '<div class="list">' + l.map(function (d) {
    return '<button class="row" data-a="open-dispute" data-id="' + d.id + '"><span class="av bad">' + ic('dispute', 20) + '</span><span class="mid"><b>' + esc(d.ref) + '</b><span>' + esc(RS[d.reason] || d.reason) + '</span></span>'
      + '<span class="end"><span class="muted small">' + ago(d.createdAt) + '</span>' + (d.status === 'resolved' ? pill('good', 'Resolved') : pill('warn', 'Open')) + '</span></button>';
  }).join('') + '</div>' : '<div class="card empty">Nothing here.</div>') + '</div>';
}
function adminUsers() {
  var l = D.admin.users;
  if (!l.length) return '<div class="card empty">No users yet.</div>';
  return '<div class="stack"><div class="note info"><span>' + ic('info', 20) + '</span><span>Until a custody provider is connected, balances are funded here. Every credit is recorded in the ledger.</span></div>' + l.map(function (u) {
    var kc = KYC[u.kyc.status];
    return '<section class="card stack" style="gap:10px"><div class="sec-head"><h2>' + esc(u.name) + '</h2>' + pill(kc[0], kc[1]) + '</div>'
      + '<dl class="kv"><div><dt>' + esc(u.role === 'merchant' ? 'Merchant' : 'Buyer') + '</dt><dd>' + esc(u.email) + '</dd></div>'
      + '<div><dt>Available</dt><dd class="num">' + fmtU(u.balance.available) + ' USDT</dd></div><div><dt>In escrow</dt><dd class="num">' + fmtU(u.balance.escrow) + ' USDT</dd></div></dl>'
      + '<div class="field"><label for="c-' + u.id + '">Add USDT</label><input class="input" id="c-' + u.id + '" inputmode="decimal" placeholder="For example 100" autocomplete="off"></div>'
      + '<button class="btn ghost" data-a="credit" data-id="' + u.id + '">Add to balance</button></section>';
  }).join('')
  + '<section class="card stack" style="gap:12px">'
  + '<div class="sec-head"><h2>Support session</h2><span class="muted small">' + esc(S.me.email) + '</span></div>'
  + '<button class="btn danger" data-a="logout">' + ic('logout', 18) + '<span>Log out</span></button>'
  + '</section></div>';
}

/* ---------- shell ---------- */
function tabsFor(role) {
  if (role === 'admin') return [['kyc', 'Identity', 'shield'], ['accounts', 'Accounts', 'lock'], ['disputes', 'Disputes', 'dispute'], ['users', 'Users', 'user']];
  return [['home', role === 'buyer' ? 'Buy' : 'Home', 'home'], ['orders', 'Orders', 'orders'], ['chats', 'Chats', 'chat'], ['disputes', 'Disputes', 'dispute'], ['account', 'Profile', 'user']];
}
function tabTitle() {
  var t = { home: S.me.role === 'buyer' ? 'Buy USDT' : 'Merchant Desk', orders: 'Orders', chats: 'Chats', disputes: 'Disputes', account: 'Profile', kyc: 'Identity checks', accounts: 'Payment accounts', users: 'Users' };
  return t[V.tab] || '';
}
function subTitle() {
  var s = V.sub;
  if (s.k === 'order') return D.order ? 'Order #' + D.order.ref : 'Order';
  if (s.k === 'chat') return D.order ? (S.me.role === 'merchant' ? D.order.buyer.name : D.order.merchant.name) : 'Chat';
  if (s.k === 'dispute') return D.dispute ? 'Dispute ' + D.dispute.ref : 'Dispute';
  if (s.k === 'new-dispute') return 'Open a dispute';
  return 'Replace account';
}
function statusPill() {
  var me = S.me;
  if (me.role === 'admin') return pill('info', 'Support');
  if (me.role === 'buyer') { var k = KYC[me.kyc.status]; return pill(k[0], k[1], true); }
  if (gateReason(me)) return pill('warn', 'Setup needed', true);
  return me.online ? pill('good', 'Online', true) : pill('mute', 'Offline', true);
}
function header() {
  var h;
  if (V.sub) {
    h = '<button class="back" data-a="back" aria-label="Back">' + ic('back', 20) + '</button><h1>' + esc(subTitle()) + '</h1>';
    if (V.sub.k === 'chat' && D.order) { var st = ST[D.order.status]; h += pill(st.c, st.l); }
  } else {
    h = (V.tab === 'home' ? '<span class="logo" aria-hidden="true">₮</span>' : '') + '<h1>' + esc(tabTitle()) + '</h1>'
      + '<div style="display:flex;align-items:center;gap:8px">' + statusPill()
      + '<button class="back" data-a="logout" aria-label="Log out" title="Log out" style="width:34px;height:34px;color:var(--muted)">' + ic('logout', 18) + '</button></div>';
  }
  $('#top').innerHTML = h;
}
function nav() {
  var role = S.me.role, tabs = tabsFor(role), admin = role === 'admin';
  var badges = {};
  if (!admin) {
    badges.orders = D.orders.filter(function (o) { return role === 'merchant' ? o.status === 'paid' : o.status === 'awaiting_payment'; }).length;
    badges.chats = Object.keys(D.unread).length;
    badges.disputes = D.orders.filter(function (o) { return o.status === 'disputed'; }).length;
  }
  $('#nav').className = 'nav' + (admin ? ' n4' : '');
  $('#nav').innerHTML = tabs.map(function (t, i) {
    var mid = !admin && i === 2, n = badges[t[0]];
    return '<button' + (mid ? ' class="mid"' : '') + ' data-a="tab" data-t="' + t[0] + '" aria-label="' + t[1] + '"' + (V.tab === t[0] ? ' aria-current="page"' : '') + '>'
      + ic(t[2], mid ? 26 : 22) + (mid ? '' : '<span>' + t[1] + '</span>') + (n ? '<span class="badge">' + n + '</span>' : '') + '</button>';
  }).join('');
}
function body() {
  var s = V.sub;
  if (s) {
    if (s.k === 'order') return orderView();
    if (s.k === 'chat') return chatView();
    if (s.k === 'dispute') return disputeView();
    if (s.k === 'new-dispute') return newDisputeView();
    return replaceView();
  }
  var role = S.me.role;
  switch (V.tab) {
    case 'home': return role === 'merchant' ? merchantHome() : buyerHome();
    case 'orders': return ordersView();
    case 'chats': return chatsView();
    case 'disputes': return role === 'admin' ? adminDisputes() : disputesView();
    case 'account': return accountView();
    case 'kyc': return adminKyc();
    case 'accounts': return adminAccounts();
    case 'users': return adminUsers();
  }
  return '';
}
function render(reset) {
  var v = $('#view'), keep = v.scrollTop;
  document.body.classList.toggle('auth-mode', !S.me);
  if (!S.me) { v.innerHTML = authView(); v.scrollTop = 0; return; }
  header(); v.innerHTML = body(); nav();
  v.scrollTop = reset ? 0 : keep;
  if (V.sub && V.sub.k === 'chat') v.scrollTop = v.scrollHeight;
}
/* Redraw after live updates without wiping anything the person is typing. */
function typing() {
  var fields = document.querySelectorAll('#view input:not([type=checkbox]):not([type=file]), #view textarea');
  for (var i = 0; i < fields.length; i++) if (fields[i].value) return true;
  return false;
}
function softRender() {
  if (!S.me) return;
  header(); nav();
  var s = V.sub;
  if (typing() || (s && (s.k === 'new-dispute' || s.k === 'replace' || s.k === 'chat'))) return;
  var ack = document.getElementById('ack'), wasChecked = ack && ack.checked;
  $('#view').innerHTML = body();
  if (wasChecked && document.getElementById('ack')) { document.getElementById('ack').checked = true; document.getElementById('rel').disabled = false; }
}

/* ---------- actions ---------- */
function logout() {
  if (S.socket) { S.socket.disconnect(); S.socket = null; }
  S.token = null; S.me = null; D = blank(); V.tab = null; V.sub = null; V.stack = []; V.authMode = 'login';
  lsSet(KEY, null);
  toast('Signed out');
  render(true);
}
async function start() {
  connectSocket();
  await go(S.me.role === 'admin' ? 'kyc' : 'home');
}
async function showOrder(id) { V.stack = []; V.sub = null; await open({ k: 'order', id: id }); }

var A = {
  tab: function (d) { return go(d.t); },
  filter: function (d) { V.filter = d.f; render(); },
  dstatus: async function (d) { V.dstatus = d.s; await loadTab('disputes'); render(); },
  'auth-mode': function (d) { V.authMode = d.m; render(true); },
  back: function () { return back(); },
  logout: function () { logout(); },
  'open-order': function (d) { return open({ k: 'order', id: d.id }); },
  'open-chat': function (d) { return open({ k: 'chat', id: d.id }); },
  'open-dispute': function (d) { return open({ k: 'dispute', id: d.id }); },
  'new-dispute': function (d) { return open({ k: 'new-dispute', id: d.id }); },
  'replace-account': function () { return open({ k: 'replace' }); },

  'toggle-online': async function () {
    S.me = (await api('POST', '/me/online', { online: !S.me.online })).user;
    toast(S.me.online ? 'You are online' : 'You are offline');
    render();
  },
  find: async function () {
    var v = ($('#buy-usdt').value || '').trim(), n = Number(v);
    if (!v || !isFinite(n) || n <= 0) { toast('Enter how many USDT you want'); return; }
    var inr = n * S.cfg.rate, l = S.cfg.limits;
    if (inr < l.minInr || inr > l.maxInr) { toast('Orders must be between ' + fmtInr(l.minInr) + ' and ' + fmtInr(l.maxInr)); return; }
    D.buyUsdt = v;
    D.merchants = (await api('GET', '/orders/merchants?usdt=' + encodeURIComponent(n))).merchants;
    render();
  },
  buy: async function (d) {
    var r = await api('POST', '/orders', { merchantId: d.id, usdt: Number(D.buyUsdt) });
    D.merchants = null; D.buyUsdt = '';
    toast('Order placed. Pay within ' + S.cfg.paymentWindowMinutes + ' minutes.');
    await showOrder(r.order.id);
  },
  cancel: async function (d) {
    await api('POST', '/orders/' + d.id + '/cancel', {});
    toast('Order cancelled');
    await loadSub(V.sub); render();
  },
  release: async function (d) {
    var ack = $('#ack');
    if (!ack || !ack.checked) { toast('Tick the box to confirm you checked your statement'); return; }
    await api('POST', '/orders/' + d.id + '/release', { statementChecked: true });
    toast('USDT released to the buyer');
    await loadSub(V.sub); await refreshMe(); render();
  },
  copy: function (d) {
    var done = function () { toast('Copied'); }, fail = function () { toast('Could not copy. Select the text and copy it.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(d.v).then(done, fail);
    fail();
  },
  'open-file': async function (d) {
    var w = window.open('', '_blank');
    var r = await fetch('/api/disputes/' + d.d + '/files/' + encodeURIComponent(d.n), { headers: { Authorization: 'Bearer ' + S.token } });
    if (!r.ok) { if (w) w.close(); throw new Error('Could not open the file'); }
    var url = URL.createObjectURL(await r.blob());
    if (w) w.location = url; else toast('Allow pop-ups to view the file');
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  },

  'kyc-approve': async function (d) { await api('POST', '/admin/kyc/' + d.id, { decision: 'approve' }); toast('Approved'); await loadTab('kyc'); render(); },
  'kyc-reject': async function (d) {
    var reason = ($('#r-' + d.id).value || '').trim();
    if (!reason) { toast('Write a reason so the person can fix it'); return; }
    await api('POST', '/admin/kyc/' + d.id, { decision: 'reject', reason: reason }); toast('Rejected'); await loadTab('kyc'); render();
  },
  'acct-approve': async function (d) {
    var name = ($('#h-' + d.id).value || '').trim();
    if (!name) { toast('Enter the holder name from the bank lookup'); return; }
    await api('POST', '/admin/payment-accounts/' + d.id, { decision: 'approve', holderName: name }); toast('Payment account approved'); await loadTab('accounts'); render();
  },
  'acct-reject': async function (d) { await api('POST', '/admin/payment-accounts/' + d.id, { decision: 'reject' }); toast('Rejected'); await loadTab('accounts'); render(); },
  credit: async function (d) {
    var n = Number(($('#c-' + d.id).value || '').trim());
    if (!isFinite(n) || n <= 0) { toast('Enter an amount in USDT'); return; }
    await api('POST', '/admin/users/' + d.id + '/credit', { usdt: n, note: 'Manual credit by support' });
    toast('Balance updated'); await loadTab('users'); render();
  }
};

document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  var f = A[b.dataset.a];
  if (f) run(function () { return f(b.dataset, b); });
});

document.addEventListener('change', function (e) {
  if (e.target.id === 'ack') { var r = $('#rel'); if (r) r.disabled = !e.target.checked; }
  if (e.target.id === 'd-files') {
    var names = Array.prototype.map.call(e.target.files, function (f) { return f.name; });
    $('#d-list').innerHTML = names.map(function (n) { return '<li>' + ic('clip', 16) + esc(n) + '</li>'; }).join('');
  }
});
document.addEventListener('input', function (e) {
  if (e.target.id === 'buy-usdt') { var el = $('#est'); if (el) el.textContent = estimate(e.target.value.trim()); }
});

document.addEventListener('submit', function (e) {
  e.preventDefault();
  var id = e.target.id;
  run(async function () {
    if (id === 'auth-form') return submitAuth();
    if (id === 'kyc-form') {
      var u = (await api('POST', '/me/kyc', { legalName: $('#k-name').value.trim(), panLast4: $('#k-pan').value.trim() })).user;
      S.me = u; toast('Sent for verification'); render();
    }
    if (id === 'upi-form') {
      S.me = (await api('PUT', '/me/payment-account', { upi: $('#upi').value.trim() })).user;
      toast('Sent for verification. You are offline until it is approved.');
      V.stack = []; V.sub = null; V.tab = 'account'; render(true);
    }
    if (id === 'paid-form') {
      var oid = V.sub.id;
      await api('POST', '/orders/' + oid + '/paid', { utr: $('#utr').value.trim() });
      toast('Marked as paid. The merchant has been told.');
      await loadSub(V.sub); render();
    }
    if (id === 'chat-form') return sendChat();
    if (id === 'dispute-form') return submitDispute();
    if (id === 'resolve-form') {
      var note = $('#res-note').value.trim();
      if (note.length < 5) { toast('Write a short note on why'); return; }
      await api('POST', '/admin/disputes/' + V.sub.id + '/resolve', { outcome: $('#res-outcome').value, note: note });
      toast('Dispute resolved');
      await loadSub(V.sub); render();
    }
  });
});

async function submitAuth() {
  var reg = V.authMode === 'register', err = $('#auth-err');
  err.textContent = '';
  var body = { email: $('#a-email').value.trim(), password: $('#a-pass').value };
  if (reg) { body.name = $('#a-name').value.trim(); var r = document.querySelector('input[name=role]:checked'); body.role = r ? r.value : 'buyer'; }
  var j;
  try { j = await api('POST', reg ? '/auth/register' : '/auth/login', body); }
  catch (e) { err.textContent = fieldMsg(e); return; }
  S.token = j.token; S.me = j.user; lsSet(KEY, S.token);
  await start();
}

function sendChat() {
  var inp = $('#msg'), text = inp.value.trim();
  if (!text) return;
  var id = V.sub.id;
  inp.value = '';
  if (S.socket && S.socket.connected) {
    joinRoom(id);
    S.socket.emit('chat:send', { orderId: id, text: text }, function (r) { if (!r || !r.ok) toast((r && r.error) || 'Message not sent'); });
  } else {
    return api('POST', '/orders/' + id + '/messages', { text: text }).then(function (r) { pushMsg(r.message); renderMsgs(); });
  }
  var again = $('#msg'); if (again) again.focus();
}

async function submitDispute() {
  var details = $('#d-details').value.trim();
  if (details.length < 10) { toast('Describe what happened in a sentence or two'); return; }
  var files = Array.prototype.slice.call($('#d-files').files);
  if (files.length > 5) { toast('Attach up to 5 files'); return; }
  for (var i = 0; i < files.length; i++) if (files[i].size > 5 * 1024 * 1024) { toast(files[i].name + ' is larger than 5 MB'); return; }
  var uploaded = [];
  if (files.length) {
    var fd = new FormData();
    files.forEach(function (f) { fd.append('files', f); });
    uploaded = (await api('POST', '/disputes/uploads', fd, true)).files;
  }
  var r = await api('POST', '/disputes', { orderId: V.sub.id, reason: $('#d-reason').value, details: details, files: uploaded });
  toast('Dispute opened. The USDT stays in escrow.');
  V.stack = []; V.sub = null; V.tab = 'disputes';
  await loadTab('disputes');
  await open({ k: 'dispute', id: r.dispute.id });
}

/* order countdown, and a refresh once the window closes so the cancel shows up */
var lastPoll = 0;
setInterval(function () {
  var c = $('#cd'), o = D.order;
  if (!c || !o || !V.sub || V.sub.k !== 'order') return;
  c.textContent = cd(o);
  if (new Date(o.expiresAt).getTime() <= Date.now() && Date.now() - lastPoll > 8000) { lastPoll = Date.now(); scheduleRefresh(); }
}, 1000);

document.addEventListener('visibilitychange', function () { if (!document.hidden && S.me) scheduleRefresh(); });

/* ---------- boot ---------- */
async function boot() {
  try { S.cfg = await api('GET', '/config'); } catch (e) { /* keep defaults */ }
  S.token = lsGet(KEY);
  if (S.token) {
    try { await refreshMe(); await start(); return; }
    catch (e) { S.token = null; S.me = null; lsSet(KEY, null); }
  }
  render(true);
}
if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
boot();
})();
