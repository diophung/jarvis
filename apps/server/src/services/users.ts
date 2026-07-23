import { newId, nowIso } from '@jarvis/core';
import type { Db, UsersTable, WorkspacesTable } from '@jarvis/db';

/**
 * User provisioning shared by email/password registration and OAuth login:
 * every new user gets their own workspace (single-user workspaces in v1.1).
 * Also home of sanitizeUser(), the ONLY shape in which a user may leave the
 * API (passwordHash never crosses the wire; hasPassword does).
 */

export interface ProvisionUserInput {
  email: string;
  name: string;
  passwordHash?: string | null;
  emailVerified?: boolean;
  avatarUrl?: string | null;
}

export interface SanitizedUser {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'member';
  emailVerified: boolean;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

/** True for SQLite/Postgres unique-constraint violations (portable check). */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === '23505') return true; // postgres unique_violation
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') return true;
  const message = (err as { message?: string }).message ?? '';
  return /unique constraint/i.test(message);
}

/**
 * Create a user (role 'owner') plus their own workspace. Throws an Error
 * with code/message 'email_taken' when the email is already registered —
 * callers decide how (not) to reveal that to the client.
 */
export async function provisionUser(
  db: Db,
  input: ProvisionUserInput,
): Promise<{ user: UsersTable; workspace: WorkspacesTable }> {
  const now = nowIso();
  const user: UsersTable = {
    id: newId('usr'),
    email: input.email.toLowerCase(),
    name: input.name,
    passwordHash: input.passwordHash ?? null,
    role: 'owner',
    emailVerified: input.emailVerified ? 1 : 0,
    avatarUrl: input.avatarUrl ?? null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insertInto('users').values(user).execute();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const taken = new Error('email_taken') as Error & { code: string };
      taken.code = 'email_taken';
      throw taken;
    }
    throw err;
  }
  const workspace: WorkspacesTable = {
    id: newId('wsp'),
    ownerUserId: user.id,
    name: `${input.name}'s Workspace`,
    createdAt: now,
    updatedAt: now,
  };
  await db.insertInto('workspaces').values(workspace).execute();
  return { user, workspace };
}

/** Strip passwordHash, expose hasPassword, normalize the 0|1 boolean. */
export function sanitizeUser(
  user: Pick<UsersTable, 'id' | 'email' | 'name' | 'role' | 'avatarUrl' | 'lastLoginAt' | 'createdAt' | 'updatedAt'> & {
    passwordHash?: string | null;
    emailVerified: number | boolean;
  },
): SanitizedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === 'member' ? 'member' : 'owner',
    emailVerified: Boolean(user.emailVerified),
    avatarUrl: user.avatarUrl ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
