// routes/logs.js
// POST /api/logs/sync - bulk-insert a device's local audit log into the
// server's audit_logs table, for centralized history across all devices.
// NOTE: the current Flutter/Kotlin client does NOT call this yet - its
// audit log stays device-local (SQLite) only, same as before. This route
// is ready for when you want to wire that up; see README "Audit log
// sync - optional, not yet wired up" for what the client-side change
// would look like.
// body: { logs: [{ senderBank, messageBody, deliveryMethod, status, occurredAt }, ...] }

const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();

router.post('/sync', authMiddleware, ah(async (req, res) => {
  const logs = Array.isArray(req.body?.logs) ? req.body.logs : [];
  if (logs.length === 0) return res.json({ ok: true, inserted: 0 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const l of logs) {
      await client.query(
        `INSERT INTO audit_logs (group_id, account_id, sender_bank, message_body, delivery_method, status, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.account.group_id,
          req.account.id,
          l.senderBank ?? null,
          l.messageBody ?? null,
          l.deliveryMethod ?? null,
          l.status ?? null,
          l.occurredAt ? new Date(l.occurredAt) : new Date(),
        ]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, inserted: logs.length });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

module.exports = router;
