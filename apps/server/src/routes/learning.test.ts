import { createDefaultRegistry } from '@donna/connectors';
import { nowIso } from '@donna/core';
import type { Db } from '@donna/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, LearningService, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createLearningService } from '../services/learning.js';
import { createSettingsService } from '../services/settings.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerLearningRoutes } from './learning.js';

let db: Db;
let workspaceId: string;
let userId: string;
let learning: LearningService;
let app: FastifyInstance;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  learning = createLearningService({ db, settings, audit });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, settings, learning } as Partial<Services> as Services,
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
  registerLearningRoutes(app, ctx);
});

describe('learning routes', () => {
  it('creates an explicit preference and lists it with explainability fields', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/learning/preferences',
      payload: { statement: 'keep summaries short' },
    });
    expect(created.statusCode).toBe(200);
    const pref = created.json().preference;
    expect(pref.origin).toBe('explicit');
    expect(pref.key).toBe('style.length');
    expect(pref.confidence).toBeGreaterThanOrEqual(0.9);

    const list = await app.inject({ method: 'GET', url: '/api/learning' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.enabled).toBe(true);
    expect(body.preferences).toHaveLength(1);
    expect(body.preferences[0].explanation.length).toBeGreaterThan(0);
    expect(body.actionableConfidence).toBeGreaterThan(0);
  });

  it('rejects sensitive explicit preferences with a clear error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/learning/preferences',
      payload: { statement: 'remember my chemotherapy schedule' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('sensitive_attribute');
  });

  it('explains a preference with its evidence', async () => {
    await learning.learnFromText(workspaceId, userId, {
      text: 'jane@acme.com is high priority',
      observedAt: nowIso(),
    });
    const pref = (await learning.list(workspaceId, userId))[0]!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/learning/preferences/${pref.id}/explain`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().preference.id).toBe(pref.id);
    expect(res.json().recentSignals.length).toBeGreaterThan(0);
  });

  it('applies corrections: confirm, pin, mark_wrong, edit, delete', async () => {
    await learning.learnFromText(workspaceId, userId, {
      text: 'use bullet points',
      observedAt: nowIso(),
    });
    const pref = (await learning.list(workspaceId, userId))[0]!;

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/learning/preferences/${pref.id}/correct`,
      payload: { action: 'confirm' },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().preference.origin).toBe('explicit');

    const pin = await app.inject({
      method: 'POST',
      url: `/api/learning/preferences/${pref.id}/correct`,
      payload: { action: 'pin' },
    });
    expect(pin.json().preference.pinned).toBe(1);

    const edit = await app.inject({
      method: 'POST',
      url: `/api/learning/preferences/${pref.id}/correct`,
      payload: { action: 'edit', statement: 'Bullet points for all briefings' },
    });
    expect(edit.json().preference.statement).toBe('Bullet points for all briefings');

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/learning/preferences/${pref.id}/correct`,
      payload: { action: 'mark_wrong' },
    });
    expect(wrong.json().preference.status).toBe('rejected');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/learning/preferences/${pref.id}`,
    });
    expect(del.json()).toEqual({ ok: true });
    expect(await learning.get(workspaceId, pref.id)).toBeNull();
  });

  it('validates corrections and 404s on unknown preferences', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/learning/preferences/lpr_x/correct',
      payload: { action: 'reconsider' },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/learning/preferences/lpr_missing/correct',
      payload: { action: 'confirm' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('accepts draft feedback and stores style signals', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/learning/draft-feedback',
      payload: {
        original:
          'Hi there, I just wanted to reach out because I was wondering if maybe we could possibly sync at some point about the roadmap, if you get a chance. No worries if not, of course! I think it would perhaps be useful.',
        edited: 'Can we sync on the roadmap Thursday? 30 minutes.',
        audience: 'team',
        channel: 'chat',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().signals).toBeGreaterThan(0);
  });

  it('runs a manual learning pass and reports counts', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/learning/run' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signals: 0, created: 0, updated: 0 });
  });

  it('searches preferences and reports contradictions', async () => {
    await learning.learnFromText(workspaceId, userId, {
      text: 'jane@acme.com is high priority',
      observedAt: nowIso(),
    });
    const search = await app.inject({ method: 'GET', url: '/api/learning/search?q=jane' });
    expect(search.json().preferences).toHaveLength(1);
    const contradictions = await app.inject({ method: 'GET', url: '/api/learning/contradictions' });
    expect(contradictions.statusCode).toBe(200);
    expect(Array.isArray(contradictions.json().contradictions)).toBe(true);
  });

  it('toggles learning globally, audits it, and blocks manual runs when disabled', async () => {
    const off = await app.inject({
      method: 'PUT',
      url: '/api/learning/settings',
      payload: { enabled: false },
    });
    expect(off.json()).toEqual({ enabled: false });
    expect(await learning.isEnabled(workspaceId)).toBe(false);

    const run = await app.inject({ method: 'POST', url: '/api/learning/run' });
    expect(run.statusCode).toBe(400);

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'learning.toggled')
      .execute();
    expect(audits).toHaveLength(1);
  });
});
