const { fromMinor } = require('./money');

const id = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);
const person = (v) => (v && v.name ? { id: id(v), name: v.name } : { id: id(v) });

function user(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    kyc: { status: u.kyc.status, legalName: u.kyc.legalName || null, panLast4: u.kyc.panLast4 || null, rejectReason: u.kyc.rejectReason || null },
    paymentAccount: u.paymentAccount && u.paymentAccount.upi
      ? { upi: u.paymentAccount.upi, holderName: u.paymentAccount.holderName, verifiedAt: u.paymentAccount.verifiedAt }
      : null,
    pendingPaymentAccount: u.pendingPaymentAccount && u.pendingPaymentAccount.upi
      ? { upi: u.pendingPaymentAccount.upi, submittedAt: u.pendingPaymentAccount.submittedAt }
      : null,
    online: u.online,
    blocked: u.blocked || false,
    balance: { available: fromMinor(u.balance.available), escrow: fromMinor(u.balance.escrow) }
  };
}

/** Orders. The viewer sees who the counterparty is and the account to pay or check. */
function order(o, viewer) {
  const vid = viewer ? String(viewer.id || viewer._id) : null;
  const mid = id(o.merchant);
  const role = viewer && viewer.role === 'admin' ? 'admin' : vid === mid ? 'merchant' : 'buyer';
  return {
    id: o.id,
    ref: o.ref,
    status: o.status,
    viewerRole: role,
    usdt: fromMinor(o.usdtMinor),
    rate: fromMinor(o.rateMinor),
    inr: fromMinor(o.inrMinor),
    merchant: person(o.merchant),
    buyer: person(o.buyer),
    payTo: o.payTo ? { upi: o.payTo.upi, holderName: o.payTo.holderName } : null,
    expectedPayerName: role === 'buyer' ? undefined : o.expectedPayerName,
    utr: o.utr || null,
    expiresAt: o.expiresAt,
    paidAt: o.paidAt || null,
    completedAt: o.completedAt || null,
    cancelledAt: o.cancelledAt || null,
    cancelReason: o.cancelReason || null,
    createdAt: o.createdAt,
    history: (o.history || []).map((h) => ({ status: h.status, at: h.at, note: h.note }))
  };
}

function dispute(d) {
  return {
    id: d.id,
    ref: d.ref,
    orderId: id(d.order),
    openedBy: id(d.openedBy),
    reason: d.reason,
    details: d.details,
    files: (d.files || []).map((f) => ({ name: f.name, originalName: f.originalName })),
    status: d.status,
    resolution: d.resolution && d.resolution.outcome
      ? { outcome: d.resolution.outcome, note: d.resolution.note || null, at: d.resolution.at }
      : null,
    createdAt: d.createdAt
  };
}

module.exports = { user, order, dispute };
