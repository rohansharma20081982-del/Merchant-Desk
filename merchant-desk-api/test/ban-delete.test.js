process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const realtime = require('../src/realtime');

let server, base;
test.before(async () => {
  server = http.createServer(app);
  realtime.init(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const req = (method, path, body, headers = {}) =>
  fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

test('block and delete workflow with ban notifications', async () => {
  // Create an admin and a regular user
  const adminId = '65f000000000000000000001';
  const customerId = '65f000000000000000000002';

  const adminToken = jwt.sign({ sub: adminId, role: 'admin' }, process.env.JWT_SECRET);
  const customerToken = jwt.sign({ sub: customerId, role: 'buyer' }, process.env.JWT_SECRET);

  let notifiedEvent = null;
  let notifiedPayload = null;
  const originalNotify = realtime.notify;
  realtime.notify = (userId, event, payload) => {
    if (userId === customerId) {
      notifiedEvent = event;
      notifiedPayload = payload;
    }
  };

  // Mock User queries
  const fakeCustomer = {
    _id: customerId,
    id: customerId,
    name: 'Test Customer',
    email: 'customer@test.com',
    role: 'buyer',
    blocked: false,
    balance: { available: 0, escrow: 0 },
    kyc: { status: 'none' },
    save: async () => {}
  };

  const fakeAdmin = {
    _id: adminId,
    id: adminId,
    name: 'Test Admin',
    email: 'admin@test.com',
    role: 'admin',
    blocked: false
  };

  const origFindById = User.findById;
  const origFindOne = User.findOne;
  const origFindOneAndUpdate = User.findOneAndUpdate;
  const origDeleteOne = User.deleteOne;
  const origOrderUpdateMany = Order.updateMany;
  const origOrderExists = Order.exists;
  const origOrderFind = Order.find;
  Order.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
  Order.exists = async () => false;
  Order.find = () => ({ then: (resolve) => resolve([]) });

  User.findById = (id) => ({
    select: () => (id === adminId ? fakeAdmin : fakeCustomer),
    then: (resolve) => resolve(id === adminId ? fakeAdmin : fakeCustomer)
  });

  User.findOne = async (query) => {
    if (query._id === adminId) return fakeAdmin;
    if (query._id === customerId) return fakeCustomer;
    return null;
  };

  User.findOneAndUpdate = async (query, update) => {
    if (query._id === customerId && update.$set && update.$set.blocked) {
      fakeCustomer.blocked = true;
      fakeCustomer.blockReason = update.$set.blockReason;
      return fakeCustomer;
    }
    return null;
  };

  let deleted = false;
  User.deleteOne = async (query) => {
    if (query._id === customerId) {
      deleted = true;
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  };

  try {
    // 1. Try to delete an unblocked user -> should fail with 400
    const delUnblocked = await req('DELETE', `/api/admin/users/${customerId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(delUnblocked.status, 400);
    const delUnblockedJson = await delUnblocked.json();
    assert.match(delUnblockedJson.error, /must be blocked before/i);

    // 2. Block the user
    const blockRes = await req('POST', `/api/admin/users/${customerId}/block`, {
      reason: 'Violated platform P2P terms and suspicious activity'
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(blockRes.status, 200);
    assert.equal(notifiedEvent, 'user:banned');
    assert.equal(notifiedPayload.action, 'blocked');
    assert.equal(notifiedPayload.reason, 'Violated platform P2P terms and suspicious activity');

    // 3. Blocked customer making request gets 403 with banned: true and reason
    const meRes = await req('GET', '/api/me', null, {
      Authorization: `Bearer ${customerToken}`
    });
    assert.equal(meRes.status, 403);
    const meJson = await meRes.json();
    assert.equal(meJson.banned, true);
    assert.equal(meJson.reason, 'Violated platform P2P terms and suspicious activity');

    // 4. Delete the blocked user
    notifiedEvent = null;
    const delRes = await req('DELETE', `/api/admin/users/${customerId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.equal(delRes.status, 200);
    assert.equal(deleted, true);
    assert.equal(notifiedEvent, 'user:banned');
    assert.equal(notifiedPayload.action, 'deleted');
  } finally {
    realtime.notify = originalNotify;
    User.findById = origFindById;
    User.findOne = origFindOne;
    User.findOneAndUpdate = origFindOneAndUpdate;
    User.deleteOne = origDeleteOne;
    Order.updateMany = origOrderUpdateMany;
    Order.exists = origOrderExists;
    Order.find = origOrderFind;
  }
});
