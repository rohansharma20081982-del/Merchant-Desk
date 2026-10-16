const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const cfg = require('./config');
const User = require('./models/User');
const chat = require('./services/chat');

let io = null;

/**
 * Socket.io: every connection is authenticated with the same JWT as the REST API.
 *  client -> server:  order:join (orderId, ack)   chat:send ({orderId, text}, ack)
 *  server -> client:  chat:message, order:updated, order:new, order:paid
 */
function init(httpServer) {
  io = new Server(httpServer, { cors: { origin: cfg.corsOrigins } });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      const payload = jwt.verify(token, cfg.jwtSecret);
      const user = await User.findById(payload.sub).select('role');
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = { id: String(user._id), role: user.role };
      return next();
    } catch (e) {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join('user:' + user.id);

    // Simple per-socket limit: 10 messages burst, refilled at 1 per second.
    let tokens = 10;
    let last = Date.now();
    const allow = () => {
      const now = Date.now();
      tokens = Math.min(10, tokens + (now - last) / 1000);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };

    socket.on('order:join', async (orderId, ack) => {
      try {
        await chat.assertParticipant(orderId, user);
        socket.join('order:' + orderId);
        if (typeof ack === 'function') ack({ ok: true });
      } catch (e) {
        if (typeof ack === 'function') ack({ ok: false, error: e.message });
      }
    });

    if (user.role === 'admin') {
      socket.join('support:admin');
    }

    socket.on('support:join', (convId, ack) => {
      if (convId) socket.join('support:' + convId);
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('chat:send', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow()) return reply({ ok: false, error: 'You are sending messages too fast' });
      try {
        const msg = await chat.sendMessage({ orderId: payload && payload.orderId, user, text: payload && payload.text });
        emitMessage(msg);
        return reply({ ok: true, id: msg.id });
      } catch (e) {
        return reply({ ok: false, error: e.message });
      }
    });
  });
  return io;
}

function emitMessage(msg) {
  if (io) io.to('order:' + msg.order).emit('chat:message', msg);
}

function emitSupportMessage(msg, conv) {
  if (!io) return;
  const convId = String(conv._id || conv.id);
  io.to('support:' + convId).emit('support:message', {
    message: msg,
    conversationId: convId
  });
  io.to('support:admin').emit('support:inbox', {
    conversationId: convId,
    lastMessageText: conv.lastMessageText,
    lastMessageAt: conv.lastMessageAt,
    unreadAdminCount: conv.unreadAdminCount
  });
  const customerId = String(conv.customer._id || conv.customer);
  io.to('user:' + customerId).emit('support:notify', {
    unreadCustomerCount: conv.unreadCustomerCount
  });
}

function emitSupportInboxUpdate() {
  if (io) io.to('support:admin').emit('support:inbox', {});
}

function orderUpdated(order) {
  if (!io) return;
  const payload = { id: order.id, ref: order.ref, status: order.status };
  io.to('order:' + order.id).emit('order:updated', payload);
  io.to('user:' + order.merchant).to('user:' + order.buyer).emit('order:updated', payload);
}

function notify(userId, event, payload) {
  if (io) io.to('user:' + userId).emit(event, payload);
}

module.exports = { init, emitMessage, emitSupportMessage, emitSupportInboxUpdate, orderUpdated, notify };
