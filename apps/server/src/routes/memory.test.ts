import { createDefaultRegistry } from '@jarvis/connectors';
import type { Db } from '@jarvis/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, MemoryService, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createMemoryService } from '../services/memory.js';
import { createSettingsService } from '../services/settings.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerMemoryRoutes } from './memory.js';

let db: Db;
let workspaceId: string;
let userId: string;
let memory: MemoryService;
let app: FastifyInstance;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  memory = createMemoryService({ db, settings, audit });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, settings, memory } as Partial<Services> as Services,
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
  registerMemoryRoutes(app, ctx);
});

describe('memory routes', () => {
  it('creates, lists, patches, and deletes entries', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/memory',
      payload: { kind: 'preference', content: 'Prefers concise replies' },
    });
    expect(created.statusCode).toBe(200);
    const entry = created.json().memory;
    expect(entry.kind).toBe('preference');
    expect(entry.origin).toBe('explicit');
    expect(entry.enabled).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/api/memory' });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().enabled).toBe(true);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/memory/${entry.id}`,
      payload: { content: 'Prefers detailed replies', enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().memory.content).toBe('Prefers detailed replies');
    expect(patched.json().memory.enabled).toBe(0);

    // Disabled entries still show on the management page.
    const listAfter = await app.inject({ method: 'GET', url: '/api/memory' });
    expect(listAfter.json().items).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/memory/${entry.id}` });
    expect(del.json()).toEqual({ ok: true });
    const empty = await app.inject({ method: 'GET', url: '/api/memory' });
    expect(empty.json().items).toHaveLength(0);
  });

  it('accepts SQLite-style 0/1 for enabled in PATCH', async () => {
    const entry = await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'Numeric toggle',
      origin: 'explicit',
    });
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/memory/${entry.id}`,
      payload: { enabled: 0 },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().memory.enabled).toBe(0);

    const enabled = await app.inject({
      method: 'PATCH',
      url: `/api/memory/${entry.id}`,
      payload: { enabled: 1 },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().memory.enabled).toBe(1);
  });

  it('validates input and 404s on missing entries', async () => {
    const badKind = await app.inject({
      method: 'POST',
      url: '/api/memory',
      payload: { kind: 'vibe', content: 'x' },
    });
    expect(badKind.statusCode).toBe(400);

    const emptyPatch = await app.inject({ method: 'PATCH', url: '/api/memory/mem_x', payload: {} });
    expect(emptyPatch.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/memory/mem_missing',
      payload: { content: 'y' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('exports all entries including disabled ones', async () => {
    const a = await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'Disabled fact',
      origin: 'explicit',
    });
    await memory.update(workspaceId, a.id, { enabled: 0 });
    await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'Enabled fact',
      origin: 'explicit',
    });
    const res = await app.inject({ method: 'GET', url: '/api/memory/export' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it('PUT /api/memory/settings toggles memory globally and audits it', async () => {
    await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: 'The launch is on Thursday',
      origin: 'explicit',
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/memory/settings',
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });

    const list = await app.inject({ method: 'GET', url: '/api/memory' });
    expect(list.json().enabled).toBe(false);
    // Assistant-facing behavior: disabled memory yields no relevant entries.
    expect(await memory.relevant(workspaceId, 'launch Thursday')).toEqual([]);
    expect(await memory.isEnabled(workspaceId)).toBe(false);

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'memory.toggled')
      .execute();
    expect(audits.length).toBe(1);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/memory/settings',
      payload: { enabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
