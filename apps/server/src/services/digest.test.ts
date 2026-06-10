import { fromJson, newId, nowIso, toJson } from '@donna/core';
import type { Db, SourceItemsTable } from '@donna/db';
import { createMockAdapter, LlmClient } from '@donna/llm';
import { describe, expect, it } from 'vitest';
import type { LlmRouterService, RoutedLlm } from '../context.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createDigestService, parseNarrative } from './digest.js';
import { createScoringService } from './scoring.js';
import { createSettingsService } from './settings.js';

const HOUR_MS = 3_600_000;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isoFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function stubLlm(): LlmRouterService {
  const routed: RoutedLlm = {
    client: new LlmClient(createMockAdapter()),
    model: 'mock',
    params: {},
    providerConfigId: null,
    providerName: 'Demo (mock)',
    kind: 'mock',
    isLocal: true,
    isMock: true,
  };
  return {
    async clientForTask() {
      return routed;
    },
    async embeddingClient() {
      return null;
    },
    async healthCheck() {
      return { ok: true, latencyMs: 0, message: 'mock' };
    },
    async listModels() {
      return [];
    },
    async status() {
      return {
        demoMode: true,
        tasks: { chat: null, summarization: null, digest: null, classification: null, embedding: null },
      };
    },
  };
}

async function insertAccount(db: Db, workspaceId: string, userId: string): Promise<string> {
  const id = newId('acc');
  const now = nowIso();
  await db
    .insertInto('sourceAccounts')
    .values({
      id,
      workspaceId,
      userId,
      provider: 'mock-email',
      category: 'email',
      displayName: 'Work Email',
      status: 'connected',
      authRef: null,
      scopes: toJson([]),
      capabilities: toJson([]),
      settings: toJson({}),
      lastSyncAt: null,
      syncCursor: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

async function insertSourceItem(
  db: Db,
  workspaceId: string,
  accountId: string,
  overrides: Partial<SourceItemsTable> = {},
): Promise<string> {
  const id = newId('itm');
  const now = nowIso();
  await db
    .insertInto('sourceItems')
    .values({
      id,
      workspaceId,
      accountId,
      provider: 'mock-email',
      category: 'email',
      externalId: id,
      dedupeKey: null,
      title: 'Routine update',
      bodyText: 'Just an update.',
      snippet: 'Just an update.',
      sender: toJson({ name: 'Jin Park', email: 'jin@meridianlabs.example' }),
      participants: toJson([]),
      itemTimestamp: isoAgo(HOUR_MS),
      dueAt: null,
      startsAt: null,
      endsAt: null,
      url: null,
      threadExternalId: null,
      projectIds: toJson([]),
      peopleIds: toJson([]),
      labels: toJson([]),
      rawMetadata: toJson({}),
      provenance: toJson({}),
      isRead: 0,
      contentHash: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .execute();
  return id;
}

function makeService(db: Db) {
  const llm = stubLlm();
  const audit = createAuditService({ db });
  const scoring = createScoringService({ db, llm, audit });
  const settings = createSettingsService({ db });
  return createDigestService({ db, llm, scoring, audit, settings });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('parseNarrative', () => {
  it('splits on the marker and rejects empty parts', () => {
    expect(parseNarrative('Summary text\n---PLAN---\nPlan text')).toEqual({
      summary: 'Summary text',
      plan: 'Plan text',
    });
    expect(parseNarrative('no marker at all')).toBeNull();
    expect(parseNarrative('---PLAN---\nonly a plan')).toBeNull();
    expect(parseNarrative('only a summary\n---PLAN---\n   ')).toBeNull();
  });
});

describe('digest generation', () => {
  it('generates a ready digest end-to-end with populated sections and the fallback narrative', async () => {
    const db = await createTestDb();
    const { workspaceId, userId } = await seedWorkspace(db);
    const accountId = await insertAccount(db, workspaceId, userId);

    await insertSourceItem(db, workspaceId, accountId, {
      title: 'URGENT: production blocker on checkout',
      bodyText: 'We are blocked on you for the fix. This is critical.',
    });
    await insertSourceItem(db, workspaceId, accountId, {
      category: 'calendar',
      title: 'Board meeting',
      bodyText: 'Agenda: review the quarterly deck before the call.',
      itemTimestamp: isoFromNow(3 * HOUR_MS),
      startsAt: isoFromNow(3 * HOUR_MS),
      endsAt: isoFromNow(4 * HOUR_MS),
    });
    await insertSourceItem(db, workspaceId, accountId, {
      title: 'Contract sign-off needed by tomorrow',
      bodyText: 'Please approve the contract. Deadline is tomorrow.',
      dueAt: isoFromNow(20 * HOUR_MS),
    });

    const service = makeService(db);
    const digest = await service.generate(workspaceId, userId, { kind: 'manual' });

    expect(digest.status).toBe('ready');
    expect(digest.kind).toBe('manual');
    expect(digest.userId).toBe(userId);
    expect(digest.generatedAt).not.toBeNull();
    expect(digest.supersedesDigestId).toBeNull();
    expect(Date.parse(digest.periodEnd) - Date.parse(digest.periodStart)).toBe(24 * HOUR_MS);

    // No real LLM routed -> deterministic fallback narrative, no model recorded.
    expect(digest.modelUsed).toBeNull();
    expect(digest.summaryMarkdown).toMatch(/^Good (morning|afternoon|evening)/);
    expect(digest.planMarkdown).toContain('## Suggested plan');

    // Sections populated from the seeded items.
    expect(digest.items.length).toBeGreaterThanOrEqual(3);
    const sections = digest.items.map((i) => i.section);
    expect(sections).toContain('risks');
    expect(sections).toContain('meetings_prep');
    const meeting = digest.items.find((i) => i.section === 'meetings_prep');
    expect(meeting!.title).toBe('Board meeting');
    expect(meeting!.sourceLabel).toBe('Work Email');
    expect(meeting!.sourceCategory).toBe('calendar');
    expect(Array.isArray(meeting!.signals)).toBe(true);
    expect(meeting!.signals.length).toBeGreaterThan(0);
    expect(meeting!.taskCandidateId).not.toBeNull();

    // digest_items rows match the plan persisted on the digest.
    const itemRows = await db
      .selectFrom('digestItems')
      .selectAll()
      .where('digestId', '=', digest.id)
      .execute();
    expect(itemRows).toHaveLength(digest.items.length);
    const stats = digest.stats;
    for (const section of new Set(sections)) {
      expect(stats[section]).toBe(sections.filter((s) => s === section).length);
    }
    // Ranks are contiguous from 0 within each section.
    for (const section of new Set(sections)) {
      const ranks = digest.items
        .filter((i) => i.section === section)
        .map((i) => i.rank)
        .sort((a, b) => a - b);
      expect(ranks).toEqual(ranks.map((_, idx) => idx));
    }

    // Audited.
    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('eventType', '=', 'digest.generated')
      .execute();
    expect(audits).toHaveLength(1);
    expect(fromJson<Record<string, unknown>>(audits[0]!.metadata, {})).toMatchObject({
      kind: 'manual',
      itemCount: digest.items.length,
    });
  });

  it('regeneration links supersedesDigestId and preserves the previous digest', async () => {
    const db = await createTestDb();
    const { workspaceId, userId } = await seedWorkspace(db);
    const accountId = await insertAccount(db, workspaceId, userId);
    await insertSourceItem(db, workspaceId, accountId, {
      title: 'URGENT: vendor escalation',
      bodyText: 'This is urgent and critical.',
    });

    const service = makeService(db);
    const first = await service.generate(workspaceId, userId, { kind: 'manual' });
    await sleep(10);
    const second = await service.generate(workspaceId, userId, {
      kind: 'manual',
      supersedesDigestId: first.id,
    });

    expect(second.supersedesDigestId).toBe(first.id);
    expect(second.id).not.toBe(first.id);

    const all = await service.list(workspaceId);
    expect(all.map((d) => d.id)).toEqual([second.id, first.id]); // newest first
    expect(all.every((d) => d.status === 'ready')).toBe(true);

    const firstAgain = await service.get(workspaceId, first.id);
    expect(firstAgain).not.toBeNull();
    expect(firstAgain!.items.length).toBe(first.items.length);

    expect(await service.get(workspaceId, 'dig_missing')).toBeNull();
  });
});
