import { createDefaultRegistry } from '@donna/connectors';
import type { Db } from '@donna/db';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext, IndexingService, Services } from '../context.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from '../services/audit.js';
import { createIngestionService } from '../services/ingestion.js';
import { createSecretsService } from '../services/secrets.js';
import { createSettingsService } from '../services/settings.js';
import { registerSourcesRoutes } from './sources.js';

function stubIndexing(): IndexingService {
  return {
    async indexText() {
      return { chunks: 1, embedded: false };
    },
    async removeIndex() {},
  };
}

interface TestApp {
  app: FastifyInstance;
  db: Db;
  userId: string;
  workspaceId: string;
}

let openApps: FastifyInstance[] = [];

async function buildApp(): Promise<TestApp> {
  const db = await createTestDb();
  const { userId, workspaceId } = await seedWorkspace(db);

  const connectors = createDefaultRegistry();
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  const secrets = createSecretsService({ appSecret: 'test-secret' });
  const indexing = stubIndexing();
  const ingestion = createIngestionService({ db, connectors, secrets, audit, settings, indexing });

  const ctx = {
    config: {} as AppContext['config'],
    db,
    connectors,
    services: { audit, settings, secrets, indexing, ingestion } as unknown as Services,
  } as AppContext;

  const app = fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  registerSourcesRoutes(app, ctx);
  await app.ready();
  openApps.push(app);
  return { app, db, userId, workspaceId };
}

afterEach(async () => {
  await Promise.all(openApps.map((app) => app.close()));
  openApps = [];
});

async function connectAccount(app: FastifyInstance, provider: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sources/accounts',
    payload: { provider },
  });
  expect(res.statusCode).toBe(200);
  return res.json().account.id as string;
}

describe('sources routes', () => {
  it('catalog lists all connectors and shows mock connectors as configured', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/sources/catalog' });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items.length).toBeGreaterThan(4);
    for (const item of items) expect(typeof item.configured).toBe('boolean');
    const mockEmail = items.find((i: { provider: string }) => i.provider === 'mock-email');
    expect(mockEmail).toMatchObject({ label: 'Demo Email', local: true, configured: true });
    const mockChat = items.find((i: { provider: string }) => i.provider === 'mock-chat');
    expect(mockChat?.configured).toBe(true);
  });

  it('connects a mock account with descriptor defaults and audits it', async () => {
    const { app, db } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sources/accounts',
      payload: { provider: 'mock-email' },
    });
    expect(res.statusCode).toBe(200);
    const { account } = res.json();
    expect(account.provider).toBe('mock-email');
    expect(account.displayName).toBe('Demo Email');
    expect(account.status).toBe('connected');
    expect(account.category).toBe('email');
    expect(account.capabilities).toContain('read');
    expect(Array.isArray(account.scopes)).toBe(true);
    expect(account.settings).toEqual({});

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'connector.connected')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(account.id);

    const listRes = await app.inject({ method: 'GET', url: '/api/sources/accounts' });
    expect(listRes.json().items).toHaveLength(1);
  });

  it('rejects unknown providers', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sources/accounts',
      payload: { provider: 'definitely-not-a-provider' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('triggers a sync and lists the runs', async () => {
    const { app } = await buildApp();
    const accountId = await connectAccount(app, 'mock-email');

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/sources/accounts/${accountId}/sync`,
      payload: {},
    });
    expect(syncRes.statusCode).toBe(200);
    const { run } = syncRes.json();
    expect(run.status).toBe('success');
    expect(run.mode).toBe('incremental');
    expect(run.triggeredBy).toBe('manual');
    expect(run.itemsCreated).toBeGreaterThan(0);
    expect(run.errors).toEqual([]);

    const runsRes = await app.inject({
      method: 'GET',
      url: `/api/sources/accounts/${accountId}/runs`,
    });
    expect(runsRes.statusCode).toBe(200);
    const { items } = runsRes.json();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(run.id);
  });

  it('returns 404 when syncing an unknown account', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sources/accounts/acc_nope/sync',
      payload: { mode: 'full' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists items with category, q and limit filters', async () => {
    const { app } = await buildApp();
    const emailAccount = await connectAccount(app, 'mock-email');
    const chatAccount = await connectAccount(app, 'mock-chat');
    for (const id of [emailAccount, chatAccount]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sources/accounts/${id}/sync`,
        payload: { mode: 'full' },
      });
      expect(res.statusCode).toBe(200);
    }

    const all = await app.inject({ method: 'GET', url: '/api/sources/items' });
    expect(all.statusCode).toBe(200);
    const categories = new Set(all.json().items.map((i: { category: string }) => i.category));
    expect(categories.has('email')).toBe(true);
    expect(categories.has('chat')).toBe(true);

    const emails = await app.inject({ method: 'GET', url: '/api/sources/items?category=email' });
    const emailItems = emails.json().items;
    expect(emailItems.length).toBeGreaterThan(0);
    for (const item of emailItems) {
      expect(item.category).toBe('email');
      expect(item.accountId).toBe(emailAccount);
    }
    // Parsed entity shapes, not JSON strings.
    expect(Array.isArray(emailItems[0].participants)).toBe(true);
    expect(typeof emailItems[0].rawMetadata).toBe('object');

    const search = await app.inject({ method: 'GET', url: '/api/sources/items?q=MSA' });
    const searchItems = search.json().items;
    expect(searchItems.length).toBeGreaterThan(0);
    for (const item of searchItems) {
      const haystack = `${item.title} ${item.snippet ?? ''}`;
      expect(haystack).toContain('MSA');
    }

    const limited = await app.inject({ method: 'GET', url: '/api/sources/items?limit=3' });
    expect(limited.json().items).toHaveLength(3);
  });

  it('gets one item with attachments and audits source access', async () => {
    const { app, db } = await buildApp();
    const accountId = await connectAccount(app, 'mock-email');
    await app.inject({
      method: 'POST',
      url: `/api/sources/accounts/${accountId}/sync`,
      payload: { mode: 'full' },
    });

    const row = await db
      .selectFrom('sourceItems')
      .select(['id'])
      .where('externalId', '=', 'demo-email-001')
      .executeTakeFirstOrThrow();

    const res = await app.inject({ method: 'GET', url: `/api/sources/items/${row.id}` });
    expect(res.statusCode).toBe(200);
    const { item, attachments } = res.json();
    expect(item.id).toBe(row.id);
    expect(item.sender).toMatchObject({ email: 'jin.park@meridianlabs.com' });
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('Northwind-MSA-v4-redline.docx');

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'source.access')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(row.id);

    const missing = await app.inject({ method: 'GET', url: '/api/sources/items/itm_nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('disconnects an account and audits it', async () => {
    const { app, db } = await buildApp();
    const accountId = await connectAccount(app, 'mock-storage');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sources/accounts/${accountId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const remaining = await db.selectFrom('sourceAccounts').select('id').execute();
    expect(remaining).toHaveLength(0);
    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'connector.disconnected')
      .execute();
    expect(audits).toHaveLength(1);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/sources/accounts/${accountId}`,
    });
    expect(again.statusCode).toBe(404);
  });
});
