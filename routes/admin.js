// routes/admin.js - everything here is protected by the x-admin-key
// header (middleware/adminAuth.js), not end-user JWTs. This is how you,
// the operator, manage accounts and subscriptions by hand.

const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const ah = require('../utils/asyncHandler');

const router = express.Router();

/** Finds a group by name (case-insensitive), creating it if it doesn't exist. */
async function findOrCreateGroup(client, groupName) {
  const existing = await client.query('SELECT id FROM groups WHERE lower(group_name) = lower($1)', [groupName]);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await client.query('INSERT INTO groups (group_name) VALUES ($1) RETURNING id', [groupName]);
  return created.rows[0].id;
}

// ---------------------------------------------------------------------
// GET /api/admin/accounts - list every account with its live status,
// so you can see at a glance who's paid and who's about to lapse.
// ---------------------------------------------------------------------
router.get('/accounts', ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.username, a.role, a.status, a.subscription_expires_at, a.created_at,
           g.id AS group_id, g.group_name,
           CASE
             WHEN a.status = 'revoked' THEN 'revoked'
             WHEN a.status = 'frozen' OR a.subscription_expires_at <= now() THEN 'frozen'
             ELSE 'active'
           END AS effective_status
    FROM accounts a JOIN groups g ON g.id = a.group_id
    ORDER BY g.group_name, a.username
  `);
  res.json({ accounts: rows });
}));

// ---------------------------------------------------------------------
// POST /api/admin/accounts - create an account (and its group, if the
// group name doesn't exist yet). `months` sets the initial paid period
// (default 1). No self-registration anywhere else in the system.
// body: { username, password, groupName, role?, months? }
// ---------------------------------------------------------------------
router.post('/accounts', ah(async (req, res) => {
  const { username, password, groupName, role, months } = req.body || {};
  if (!username || !password || !groupName) {
    return res.status(400).json({ error: 'username, password and groupName are required' });
  }
  const monthsToAdd = Number.isInteger(months) && months > 0 ? months : 1;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupId = await findOrCreateGroup(client, groupName);
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      `INSERT INTO accounts (group_id, username, password_hash, role, status, subscription_expires_at)
       VALUES ($1, $2, $3, $4, 'active', now() + ($5 || ' months')::interval)
       RETURNING id, username, role, status, subscription_expires_at`,
      [groupId, username, passwordHash, role === 'admin' ? 'admin' : 'member', monthsToAdd]
    );
    await client.query('COMMIT');
    res.json({ ok: true, account: rows[0], groupId });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    throw e;
  } finally {
    client.release();
  }
}));

// ---------------------------------------------------------------------
// POST /api/admin/accounts/:username/extend - THE manual-payment action.
// You collect payment by whatever means off-platform, then call this to
// add however many months they paid for. Always extends from whichever
// is later: the account's current expiry, or now - so paying early never
// loses them time, and paying late doesn't backdate against them either.
// Also flips a frozen/revoked account back to active.
// body: { months, amount?, note? }
// ---------------------------------------------------------------------
router.post('/accounts/:username/extend', ah(async (req, res) => {
  const { months, amount, note } = req.body || {};
  if (!Number.isInteger(months) || months <= 0) {
    return res.status(400).json({ error: 'months must be a positive integer' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE accounts
         SET subscription_expires_at = GREATEST(subscription_expires_at, now()) + ($1 || ' months')::interval,
             status = 'active'
       WHERE username = $2
       RETURNING id, group_id, username, status, subscription_expires_at`,
      [months, req.params.username]
    );
    const account = rows[0];
    if (!account) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No account with that username' });
    }

    await client.query(
      `INSERT INTO payments (group_id, recorded_by, months_added, amount, note, new_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [account.group_id, 'admin', months, amount ?? null, note ?? null, account.subscription_expires_at]
    );
    await client.query('COMMIT');

    req.app.get('io').to(`group:${account.group_id}`).emit('account_status_changed', {
      status: 'active',
      subscriptionExpiresAt: account.subscription_expires_at,
    });
    res.json({ ok: true, account });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---------------------------------------------------------------------
// POST /api/admin/accounts/:username/freeze - manually suspend access
// regardless of subscription expiry (e.g. suspicious activity).
// POST /api/admin/accounts/:username/revoke - permanently disable.
// ---------------------------------------------------------------------
router.post('/accounts/:username/freeze', ah((req, res) => setStatus(req, res, 'frozen')));
router.post('/accounts/:username/revoke', ah((req, res) => setStatus(req, res, 'revoked')));

async function setStatus(req, res, status) {
  const { rows } = await pool.query(
    'UPDATE accounts SET status = $1 WHERE username = $2 RETURNING id, group_id, username, status',
    [status, req.params.username]
  );
  const account = rows[0];
  if (!account) return res.status(404).json({ error: 'No account with that username' });
  req.app.get('io').to(`group:${account.group_id}`).emit('account_status_changed', { status });
  res.json({ ok: true, account });
}

// ---------------------------------------------------------------------
// GET /api/admin/payments?groupId=... - payment/extension history, so
// you can see who added how many months and when.
// ---------------------------------------------------------------------
router.get('/payments', ah(async (req, res) => {
  const { groupId } = req.query;
  const { rows } = await pool.query(
    groupId
      ? 'SELECT * FROM payments WHERE group_id = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM payments ORDER BY created_at DESC LIMIT 200',
    groupId ? [groupId] : []
  );
  res.json({ payments: rows });
}));

// ---------------------------------------------------------------------
// PUT /api/admin/groups/:groupId/numbers - admin override of recipients,
// same replace-all semantics as the member-facing route.
// ---------------------------------------------------------------------
router.put('/groups/:groupId/numbers', ah(async (req, res) => {
  const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
  const groupId = req.params.groupId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM group_recipients WHERE group_id = $1', [groupId]);
    for (const n of numbers) {
      await client.query(
        'INSERT INTO group_recipients (group_id, phone_number) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [groupId, n]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  req.app.get('io').to(`group:${groupId}`).emit('group_updated', { numbers });
  res.json({ ok: true, numbers });
}));

module.exports = router;
