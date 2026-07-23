import type { Db } from '@jarvis/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { SETTING_KEYS, type MemoryService, type SettingsService } from '../context.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createMemoryService } from './memory.js';
import { createSettingsService } from './settings.js';

let db: Db;
let workspaceId: string;
let userId: string;
let memory: MemoryService;
let settings: SettingsService;

async function auditEvents(eventType: string) {
  return db
    .selectFrom('auditLogs')
    .selectAll()
    .where('workspaceId', '=', workspaceId)
    .where('eventType', '=', eventType)
    .execute();
}

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  settings = createSettingsService({ db });
  memory = createMemoryService({ db, settings, audit });
});

describe('memory CRUD + audits', () => {
  it('creates, updates, and deletes entries with audit events', async () => {
    const entry = await memory.create(workspaceId, userId, {
      kind: 'preference',
      content: 'Prefers morning meetings',
      origin: 'explicit',
    });
    expect(entry.enabled).toBe(1);
    expect(entry.kind).toBe('preference');
    expect((await auditEvents('memory.created')).length).toBe(1);

    const updated = await memory.update(workspaceId, entry.id, { content: 'Prefers afternoon meetings' });
    expect(updated.content).toBe('Prefers afternoon meetings');
    expect((await auditEvents('memory.updated')).length).toBe(1);

    const toggled = await memory.update(workspaceId, entry.id, { enabled: 0 });
    expect(toggled.enabled).toBe(0);
    expect((await auditEvents('memory.toggled')).length).toBe(1);

    await memory.remove(workspaceId, entry.id);
    expect((await auditEvents('memory.deleted')).length).toBe(1);
    expect(await memory.list(workspaceId, { includeDisabled: true })).toHaveLength(0);
  });

  it('list excludes disabled entries by default; exportAll includes them', async () => {
    const a = await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'Works at Meridian Labs',
      origin: 'explicit',
    });
    await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'Based in Singapore',
      origin: 'explicit',
    });
    await memory.update(workspaceId, a.id, { enabled: 0 });

    expect(await memory.list(workspaceId)).toHaveLength(1);
    expect(await memory.list(workspaceId, { includeDisabled: true })).toHaveLength(2);
    expect(await memory.exportAll(workspaceId)).toHaveLength(2);
  });

  it('404s when updating or removing a missing entry', async () => {
    await expect(memory.update(workspaceId, 'mem_missing', { content: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(memory.remove(workspaceId, 'mem_missing')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('enabled flag', () => {
  it('isEnabled defaults to true and follows the memory.enabled setting', async () => {
    expect(await memory.isEnabled(workspaceId)).toBe(true);
    await settings.set(workspaceId, SETTING_KEYS.memoryEnabled, false);
    expect(await memory.isEnabled(workspaceId)).toBe(false);
  });

  it('relevant returns [] when memory is disabled', async () => {
    await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'The quarterly budget review happens on Fridays',
      origin: 'explicit',
    });
    await settings.set(workspaceId, SETTING_KEYS.memoryEnabled, false);
    expect(await memory.relevant(workspaceId, 'quarterly budget review')).toEqual([]);
    expect(await memory.isEnabled(workspaceId)).toBe(false);
  });
});

describe('relevant', () => {
  it('ranks by token overlap + confidence and bumps lastUsedAt', async () => {
    const budget = await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'Quarterly budget review with Priya covers the infra budget',
      origin: 'explicit',
      confidence: 0.9,
    });
    await memory.create(workspaceId, userId, {
      kind: 'preference',
      content: 'Prefers tea over coffee',
      origin: 'explicit',
    });
    const weak = await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'Budget approvals go through finance',
      origin: 'inferred',
      confidence: 0.4,
    });

    const results = await memory.relevant(workspaceId, 'what about the quarterly budget review?');
    expect(results.length).toBe(2);
    expect(results[0]?.id).toBe(budget.id);
    expect(results[1]?.id).toBe(weak.id);
    expect(results[0]?.lastUsedAt).toBeTruthy();

    const row = await db
      .selectFrom('memoryEntries')
      .select(['lastUsedAt'])
      .where('id', '=', budget.id)
      .executeTakeFirstOrThrow();
    expect(row.lastUsedAt).toBeTruthy();
  });

  it('skips disabled entries and respects the limit', async () => {
    const disabled = await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'launch launch launch launch',
      origin: 'explicit',
    });
    await memory.update(workspaceId, disabled.id, { enabled: 0 });
    for (let i = 0; i < 7; i += 1) {
      await memory.create(workspaceId, userId, {
        kind: 'fact',
        content: `Launch plan item ${i} for the meridian launch`,
        origin: 'explicit',
      });
    }
    const top = await memory.relevant(workspaceId, 'meridian launch plan');
    expect(top.length).toBe(5); // default limit
    expect(top.some((m) => m.id === disabled.id)).toBe(false);
    const limited = await memory.relevant(workspaceId, 'meridian launch plan', 2);
    expect(limited.length).toBe(2);
  });
});
