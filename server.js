// server.js
// npm install  &&  node server.js
//
// BlackTecch SMS Hub backend: central auth, monthly subscriptions
// (manually extended by an admin - no payment gateway), centrally
// managed recipient groups, and the Socket.IO endpoint the Android
// client's SocketSender.kt posts transactions to when online.
//
// Route map (kept path-compatible with the existing Flutter client):
//   POST /api/auth/login
//   GET  /api/auth/verify
//   GET  /api/group/:groupId/numbers
//   PUT  /api/group/:groupId/numbers
//   POST /api/logs/sync                       (optional, not yet called by the client)
//   ---- admin only (x-admin-key header) ----
//   GET    /api/admin/accounts
//   POST   /api/admin/accounts
//   POST   /api/admin/accounts/:username/extend   <- add months (manual payment)
//   POST   /api/admin/accounts/:username/freeze
//   POST   /api/admin/accounts/:username/revoke
//   GET    /api/admin/payments
//   PUT    /api/admin/groups/:groupId/numbers
//   ---- Socket.IO ----
//   "bank_sms" event (JWT-gated) - the online SMS-forwarding path

require('dotenv').config();
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { scheduleFreezeJob } = require('./cron/freezeExpired');
const { effectiveStatus } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const groupRoutes = require('./routes/group');
const adminRoutes = require('./routes/admin');
const logRoutes = require('./routes/logs');
const adminAuth = require('./middleware/adminAuth');

for (const required of ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_KEY']) {
  if (!process.env[required]) {
    console.error(`Missing required env var ${required} - copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io); // routes read it via req.app.get('io') to emit live updates

app.use('/api/auth', authRoutes);
app.use('/api/group', groupRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/admin', adminAuth, adminRoutes);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Centralized error handler so a thrown DB error returns JSON, not an HTML stack trace.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------
// Socket.IO - JWT-gated, same live-status check as the HTTP middleware,
// so a frozen/revoked account can't keep forwarding over the socket
// either. Devices join a `group:<groupId>` room so admin actions
// (extend/freeze/revoke, recipient updates) can push to them live.
// ---------------------------------------------------------------------

io.use(async (socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token || '', process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, group_id, status, subscription_expires_at FROM accounts WHERE id = $1',
      [payload.sub]
    );
    const account = rows[0];
    if (!account || effectiveStatus(account) !== 'active') return next(new Error('Unauthorized'));
    socket.account = account;
    next();
  } catch (e) {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(`group:${socket.account.group_id}`);

  // Matches android/.../SocketSender.kt: emits "bank_sms" with an ack
  // callback; the native dispatcher falls back to SIM SMS if this
  // doesn't come back { ok: true } within its timeout.
  socket.on('bank_sms', async (payload, ack) => {
    console.log(`[${socket.account.group_id}] bank SMS from`, payload?.sender, '->', payload?.recipients);

    // Optional: mirror into audit_logs server-side even though the
    // client doesn't call /api/logs/sync yet - harmless, additive.
    try {
      await pool.query(
        `INSERT INTO audit_logs (group_id, account_id, sender_bank, message_body, delivery_method, status, occurred_at)
         VALUES ($1, $2, $3, $4, 'ONLINE_SOCKET', 'SUCCESS', $5)`,
        [socket.account.group_id, socket.account.id, payload?.sender ?? null, payload?.body ?? null,
          payload?.receivedAt ? new Date(payload.receivedAt) : new Date()]
      );
    } catch (e) {
      console.error('Failed to log bank_sms to audit_logs', e);
    }

    io.to(`group:${socket.account.group_id}`).emit('payment_notification', payload);
    if (typeof ack === 'function') ack({ ok: true });
  });
});

scheduleFreezeJob();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`BlackTecch SMS Hub server listening on :${PORT}`));
