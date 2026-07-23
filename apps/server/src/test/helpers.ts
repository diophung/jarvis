import { newId, nowIso } from '@jarvis/core';
import { createDb, migrateToLatest, type Db } from '@jarvis/db';

/** Fresh in-memory SQLite db with the full schema. */
export async function createTestDb(): Promise<Db> {
  const db = createDb({ sqlitePath: ':memory:' });
  await migrateToLatest(db);
  return db;
}

/** Seed a user + workspace; returns their ids. */
export async function seedWorkspace(
  db: Db,
  opts: { email?: string; name?: string } = {},
): Promise<{ userId: string; workspaceId: string }> {
  const now = nowIso();
  const userId = newId('usr');
  const workspaceId = newId('wsp');
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: opts.email ?? `test-${userId}@example.com`,
      name: opts.name ?? 'Test User',
      passwordHash: null,
      role: 'owner',
      emailVerified: 0,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  await db
    .insertInto('workspaces')
    .values({ id: workspaceId, ownerUserId: userId, name: 'Test Workspace', createdAt: now, updatedAt: now })
    .execute();
  return { userId, workspaceId };
}
