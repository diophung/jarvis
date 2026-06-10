import { createDefaultRegistry } from '@donna/connectors';
import type { Db } from '@donna/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, AuditService, Services, SettingsService } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createSettingsService } from '../services/settings.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerAuditRoutes } from './audit.js';

let db: Db;
let workspaceId: string;
let userId: string;
let audit: AuditService;
let settings: SettingsService;
let app: FastifyInstance;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  audit = createAuditService({ db });
  settings = createSettingsService({ db });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, settings } as Partial<Services> as Services,
  };
  app = fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  app.setErrorHandler((err: Error, _request, reply) => {
    const status = err instanceof HttpError ? err.statusCode : 500;
    const code = err instanceof HttpError ? err.code : 'error';
    void reply.code(status).send({ error: { code, message: err.message } });
  });
  registerAuditRoutes(app, ctx);
});

describe('GET /api/audit', () => {
  it('filters by eventType, actor, and limit with parsed metadata', async () => {
    await audit.log({
      workspaceId,
      userId,
      eventType: 'policy.updated',
      actor: 'user',
      summary: 'Policy changed',
      metadata: { capability: 'email.send' },
    });
    await audit.log({
      workspaceId,
      userId,
      eventType: 'agent.action.executed',
      actor: 'agent',
      summary: 'Action ran',
    });
    await audit.log({
      workspaceId,
      userId,
      eventType: 'agent.action.executed',
      actor: 'agent',
      summary: 'Another action ran',
    });

    const all = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toHaveLength(3);

    const byType = await app.inject({ method: 'GET', url: '/api/audit?eventType=policy.updated' });
    expect(byType.json().items).toHaveLength(1);
    expect(byType.json().items[0].eventType).toBe('policy.updated');
    // Metadata is parsed JSON, not a string.
    expect(byType.json().items[0].metadata).toEqual({ capability: 'email.send' });

    const byActor = await app.inject({ method: 'GET', url: '/api/audit?actor=agent' });
    expect(byActor.json().items).toHaveLength(2);

    const limited = await app.inject({ method: 'GET', url: '/api/audit?limit=1' });
    expect(limited.json().items).toHaveLength(1);

    const bad = await app.inject({ method: 'GET', url: '/api/audit?limit=banana' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('settings routes', () => {
  it('GET /api/settings returns all settings; PUT updates allowed keys and audits', async () => {
    await settings.set(workspaceId, 'sync.intervalMinutes', 15);

    const before = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(before.statusCode).toBe(200);
    expect(before.json().settings['sync.intervalMinutes']).toBe(15);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/digest.schedule',
      payload: { value: { cron: '0 7 * * *', enabled: true } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true });

    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().settings['digest.schedule']).toEqual({ cron: '0 7 * * *', enabled: true });

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'settings.updated')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe('digest.schedule');
  });

  it('rejects keys outside the known prefixes and bodies without value', async () => {
    for (const key of ['llm.apiKey', 'random', 'digest', 'auth.mode']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/settings/${encodeURIComponent(key)}`,
        payload: { value: 1 },
      });
      expect(res.statusCode).toBe(400);
    }
    // Allowed prefixes: digest., memory., sync., assistant.
    for (const key of ['memory.enabled', 'sync.intervalMinutes', 'assistant.responseStyle']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/settings/${key}`,
        payload: { value: true },
      });
      expect(res.statusCode).toBe(200);
    }

    const noValue = await app.inject({
      method: 'PUT',
      url: '/api/settings/digest.schedule',
      payload: {},
    });
    expect(noValue.statusCode).toBe(400);
  });
});
