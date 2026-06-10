/**
 * Self-hosted "forgot password" recovery path: set a user's password from the
 * server shell and revoke all of their sessions.
 *
 * Usage: tsx src/scripts/reset-password.ts <email> <new-password>
 *
 * The password is taken from argv (never echoed back, never logged).
 */
import { nowIso } from '@donna/core';
import { createDb } from '@donna/db';
import bcrypt from 'bcryptjs';
import { validatePassword } from '../auth.js';
import { loadConfig } from '../config.js';
import { createSessionsService } from '../services/sessions.js';

const [email, newPassword] = process.argv.slice(2);
if (!email || !newPassword) {
  console.error('Usage: tsx src/scripts/reset-password.ts <email> <new-password>');
  process.exit(1);
}

const policyProblem = validatePassword(newPassword, email);
if (policyProblem) {
  console.error(policyProblem);
  process.exit(1);
}

const config = loadConfig();
const db = createDb({ databaseUrl: config.env.DATABASE_URL, sqlitePath: config.sqlitePath });
try {
  const user = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  if (!user) {
    console.error(`No user found with email ${email.toLowerCase()}`);
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db
    .updateTable('users')
    .set({ passwordHash, updatedAt: nowIso() })
    .where('id', '=', user.id)
    .execute();
  const revoked = await createSessionsService(db).revokeAllForUser(user.id);
  console.log(`Password reset for ${user.email}; ${revoked} session(s) revoked.`);
} finally {
  await db.destroy();
}
