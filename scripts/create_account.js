// scripts/create_account.js
// Local convenience CLI for an admin with direct DB access. Talks to
// PostgreSQL directly (via db.js), not HTTP - handy when you're already
// on the server box. For remote provisioning, use the HTTP admin API:
//   curl -X POST http://your-server:3000/api/admin/accounts \
//     -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
//     -d '{"username":"team-addis","password":"...","groupName":"Addis Branch","months":1}'
//
// Usage: node scripts/create_account.js <username> <password> <groupName> [months] [role]
//   months defaults to 1, role defaults to "member" (or pass "admin")

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db');

async function findOrCreateGroup(groupName) {
  const existing = await pool.query('SELECT id FROM groups WHERE lower(group_name) = lower($1)', [groupName]);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await pool.query('INSERT INTO groups (group_name) VALUES ($1) RETURNING id', [groupName]);
  return created.rows[0].id;
}

async function main() {
  const [, , username, password, groupName, monthsArg, roleArg] = process.argv;
  if (!username || !password || !groupName) {
    console.error('Usage: node scripts/create_account.js <username> <password> <groupName> [months] [role]');
    process.exit(1);
  }
  const months = Number.parseInt(monthsArg, 10) || 1;
  const role = roleArg === 'admin' ? 'admin' : 'member';

  const groupId = await findOrCreateGroup(groupName);
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO accounts (group_id, username, password_hash, role, status, subscription_expires_at)
     VALUES ($1, $2, $3, $4, 'active', now() + ($5 || ' months')::interval)
     RETURNING username, subscription_expires_at`,
    [groupId, username, passwordHash, role, months]
  );

  console.log(
    `Created "${rows[0].username}" in group "${groupName}" (${role}), paid through ${rows[0].subscription_expires_at}`
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
