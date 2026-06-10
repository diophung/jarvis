import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { migrateToLatest } from './migrate.js';

describe('db', () => {
  it('migrates an in-memory sqlite db and round-trips a user', async () => {
    const db = createDb({ sqlitePath: ':memory:' });
    await migrateToLatest(db);

    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: 'usr_test1',
        email: 'test@example.com',
        name: 'Test User',
        passwordHash: null,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', 'test@example.com')
      .executeTakeFirst();
    expect(user?.id).toBe('usr_test1');
    expect(user?.passwordHash).toBeNull();

    // camelCase plugin maps to snake_case columns
    await db
      .insertInto('appSettings')
      .values({
        id: 'set_1',
        workspaceId: 'wsp_1',
        key: 'digest.schedule',
        value: JSON.stringify({ cron: '0 7 * * *' }),
        updatedAt: now,
      })
      .execute();
    const setting = await db
      .selectFrom('appSettings')
      .selectAll()
      .where('workspaceId', '=', 'wsp_1')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(setting.value)).toEqual({ cron: '0 7 * * *' });

    await db.destroy();
  });

  it('migration is idempotent', async () => {
    const db = createDb({ sqlitePath: ':memory:' });
    await migrateToLatest(db);
    await migrateToLatest(db);
    await db.destroy();
  });
});
