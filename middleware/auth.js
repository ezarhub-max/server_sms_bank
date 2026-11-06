// middleware/auth.js
// Verifies the JWT AND re-checks the account's live status/expiry in
// PostgreSQL on every request - not just at /api/auth/verify. A cached
// token alone is never enough to keep using the API once an admin has
// frozen/revoked the account or the subscription has lapsed, even if the
// nightly freeze cron (cron/freezeExpired.js) hasn't run yet.

const jwt = require('jsonwebtoken');
const pool = require('../db');

/** 'active' | 'frozen' | 'revoked' -> the effective status right now,
 *  folding in "subscription lapsed but cron hasn't flipped the flag yet". */
function effectiveStatus(account) {
  if (account.status === 'revoked') return 'revoked';
  if (account.status === 'frozen') return 'frozen';
  if (new Date(account.subscription_expires_at) <= new Date()) return 'frozen'; // lapsed
  return 'active';
}

/** Always a 403 - the two reasons just carry a different code/message
 *  so the client can show the right one ("revoked" vs "please renew"). */
function deniedResponse(status) {
  if (status === 'revoked') {
    return { code: 'ACCOUNT_REVOKED', message: 'This account has been removed by an administrator.' };
  }
  return {
    code: 'ACCOUNT_EXPIRED',
    message: 'Your monthly subscription has expired. Contact your administrator to renew.',
  };
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { rows } = await pool.query(
    'SELECT id, group_id, username, role, status, subscription_expires_at FROM accounts WHERE id = $1',
    [payload.sub]
  );
  const account = rows[0];
  if (!account) return res.status(401).json({ error: 'Account no longer exists' });

  const status = effectiveStatus(account);
  if (status !== 'active') return res.status(403).json(deniedResponse(status));

  req.account = account; // { id, group_id, username, role, status, subscription_expires_at }
  next();
}

module.exports = { authMiddleware, effectiveStatus, deniedResponse };
