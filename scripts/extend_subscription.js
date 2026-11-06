// scripts/extend_subscription.js
// The "they just paid me" CLI - adds N months to an account's
// subscription and flips it back to active if it was frozen. Same logic
// as POST /api/admin/accounts/:username/extend, for when you'd rather
// run a command on the server than curl the HTTP API.
//
// Usage: node scripts/extend_subscription.js <username> <months> [amount] [note]
// Example: node scripts/extend_subscription.js team-addis 1 500 "Cash, Nov 2026"

require('dotenv').config();
const pool = require('../db');

async function main() {
  const [, , username, monthsArg, amountArg, ...noteParts] = process.argv;
  const months = Number.parseInt(monthsArg, 10);
  if (!username || !Number.isInteger(months) || months <= 0) {
    console.error('Usage: node scripts/extend_subscription.js <username> <months> [amount] [note]');
    process.exit(1);
  }
  const amount = amountArg ? Number.parseFloat(amountArg) : null;
  const note = noteParts.join(' ') || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE accounts
         SET subscription_expires_at = GREATEST(subscription_expires_at, now()) + ($1 || ' months')::interval,
             status = 'active'
       WHERE username = $2
       RETURNING group_id, username, subscription_expires_at`,
      [months, username]
    );
    const account = rows[0];
    if (!account) throw new Error(`No account named "${username}"`);

    await client.query(
      `INSERT INTO payments (group_id, recorded_by, months_added, amount, note, new_expires_at)
       VALUES ($1, 'cli', $2, $3, $4, $5)`,
      [account.group_id, months, amount, note, account.subscription_expires_at]
    );
    await client.query('COMMIT');
    console.log(`"${account.username}" is now paid through ${account.subscription_expires_at}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
