// routes/group.js
// Paths match the Flutter client's _ApiClient exactly:
//   GET /api/group/:groupId/numbers
//   PUT /api/group/:groupId/numbers   (full-list replace, as the client sends it)

const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();

/** Members may only touch their own group; admin-role accounts may touch any. */
function canAccessGroup(account, groupId) {
  return account.role === 'admin' || account.group_id === groupId;
}

router.get('/:groupId/numbers', authMiddleware, ah(async (req, res) => {
  if (!canAccessGroup(req.account, req.params.groupId)) return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await pool.query(
    'SELECT phone_number FROM group_recipients WHERE group_id = $1 ORDER BY phone_number',
    [req.params.groupId]
  );
  res.json({ numbers: rows.map((r) => r.phone_number) });
}));

router.put('/:groupId/numbers', authMiddleware, ah(async (req, res) => {
  if (!canAccessGroup(req.account, req.params.groupId)) return res.status(403).json({ error: 'Forbidden' });
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

  req.app.get('io').to(`group:${groupId}`).emit('group_updated', { numbers }); // live push to connected teammates
  res.json({ ok: true, numbers });
}));

module.exports = router;
