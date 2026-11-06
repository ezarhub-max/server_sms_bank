// routes/auth.js
// Paths match the Flutter client's _ApiClient exactly:
//   POST /api/auth/login   -> {token, username, groupId, role}
//   GET  /api/auth/verify  -> 200 while active; the app only checks the
//                             status code, so any non-200 (401/403) makes
//                             it log the device out - same contract as
//                             before, now backed by real subscription logic.

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { authMiddleware, effectiveStatus, deniedResponse } = require('../middleware/auth');
const ah = require('../utils/asyncHandler');

const router = express.Router();
const TOKEN_TTL = '365d'; // long-lived: the app is offline-first, no refresh flow

function signToken(account) {
  return jwt.sign(
    { sub: account.id, username: account.username, groupId: account.group_id, role: account.role },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

router.post('/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  const { rows } = await pool.query('SELECT * FROM accounts WHERE username = $1', [username]);
  const account = rows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }

  // Reject at login time too (not just at /verify) so a lapsed account
  // gets an immediate, clear reason instead of appearing to log in and
  // then being kicked out moments later by the background verify check.
  const status = effectiveStatus(account);
  if (status !== 'active') return res.status(403).json(deniedResponse(status));

  res.json({
    token: signToken(account),
    username: account.username,
    groupId: account.group_id,
    role: account.role,
  });
}));

router.get('/verify', authMiddleware, (req, res) => {
  res.json({
    valid: true,
    username: req.account.username,
    groupId: req.account.group_id,
    role: req.account.role,
    subscriptionExpiresAt: req.account.subscription_expires_at,
  });
});

module.exports = router;
