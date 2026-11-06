// cron/freezeExpired.js
// Runs daily at 00:00 UTC: any 'active' account whose subscription has
// lapsed gets flipped to 'frozen'. This is a backstop, not the only
// enforcement - middleware/auth.js already blocks lapsed accounts in
// real time on every request, so a device can't keep working just
// because the cron hasn't ticked yet. The cron's job is to make the
// status column (and anything reading it, like the admin list) reflect
// reality even when nobody happens to call the API for that account.

const cron = require('node-cron');
const pool = require('../db');

async function freezeExpiredAccounts() {
  const { rows } = await pool.query(`
    UPDATE accounts
       SET status = 'frozen'
     WHERE status = 'active' AND subscription_expires_at < now()
     RETURNING username, group_id
  `);
  if (rows.length > 0) {
    console.log(`[freeze-cron] froze ${rows.length} expired account(s): ${rows.map((r) => r.username).join(', ')}`);
  }
  return rows;
}

/** Call once at server startup. Also exports freezeExpiredAccounts for
 *  manual/test invocation (e.g. `node -e "require('./cron/freezeExpired').freezeExpiredAccounts()"`). */
function scheduleFreezeJob() {
  cron.schedule('0 0 * * *', () => {
    freezeExpiredAccounts().catch((e) => console.error('[freeze-cron] failed', e));
  });
  console.log('[freeze-cron] scheduled for 00:00 UTC daily');
}

module.exports = { scheduleFreezeJob, freezeExpiredAccounts };
