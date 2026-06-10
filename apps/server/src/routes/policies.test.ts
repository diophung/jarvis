import { CAPABILITY_CATALOG } from '@donna/core';
import { createDefaultRegistry } from '@donna/connectors';
import type { Db } from '@donna/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { ActionsService, AppContext, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createActionsService } from '../services/actions.js';
import { createAuditService } from '../services/audit.js';
import { createMemoryService } from '../services/memory.js';
import { createSecretsService } from '../services/secrets.js';
import { createSettingsService } from '../services/settings.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerPolicyRoutes } from './policies.js';

let db: Db;
let workspaceId: string;
let userId: string;
let actions: ActionsService;
let app: FastifyInstance;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  const memory = createMemoryService({ db, settings, audit });
  actions = createActionsService({
    db,
    connectors: createDefaultRegistry(),
    secrets: createSecretsService({ appSecret: 'test-secret' }),
    audit,
    memory,
  });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, settings, memory, actions } as Partial<Services> as Services,
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
  registerPolicyRoutes(app, ctx);
});

async function proposeEmailSend() {
  return actions.propose({
    workspaceId,
    userId,
    capability: 'email.send',
    actionType: 'send_email',
    params: { to: 'a@b.com', subject: 'Hi' },
    target: {},
    reason: 'test',
    preview: { summary: 'Send email' },
  });
}

describe('GET /api/policies/catalog', () => {
  it('returns the capability catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/policies/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(CAPABILITY_CATALOG.length);
    expect(body.items.map((c: { id: string }) => c.id)).toContain('email.send');
  });
});

describe('PUT /api/policies/:capability + DELETE /api/policies/:id', () => {
  it('round-trips and changes the evaluatePolicy outcome', async () => {
    // Default: email.send requires approval.
    const before = await proposeEmailSend();
    expect(before.decision.effect).toBe('require_approval');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/policies/${encodeURIComponent('email.send')}`,
      payload: { effect: 'deny' },
    });
    expect(put.statusCode).toBe(200);
    const policy = put.json().policy;
    expect(policy.capability).toBe('email.send');
    expect(policy.effect).toBe('deny');
    expect(policy.createdBy).toBe('user');
    expect(policy.scope).toEqual({});

    const denied = await proposeEmailSend();
    expect(denied.decision.effect).toBe('deny');
    expect(denied.action.status).toBe('denied');

    // Update in place (upsert keeps one row).
    const put2 = await app.inject({
      method: 'PUT',
      url: '/api/policies/email.send',
      payload: { effect: 'auto_approve' },
    });
    expect(put2.json().policy.id).toBe(policy.id);
    expect(put2.json().policy.effect).toBe('auto_approve');

    const listed = await app.inject({ method: 'GET', url: '/api/policies' });
    expect(listed.json().items).toHaveLength(1);

    // Delete reverts to the default.
    const del = await app.inject({ method: 'DELETE', url: `/api/policies/${policy.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    const after = await proposeEmailSend();
    expect(after.decision.effect).toBe('require_approval');

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'policy.updated')
      .execute();
    expect(audits.length).toBe(3); // two PUTs + one DELETE
  });

  it('rejects unknown capabilities and invalid effects', async () => {
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/policies/not.a.capability',
      payload: { effect: 'deny' },
    });
    expect(unknown.statusCode).toBe(400);

    const badEffect = await app.inject({
      method: 'PUT',
      url: '/api/policies/email.send',
      payload: { effect: 'allow' },
    });
    expect(badEffect.statusCode).toBe(400);

    const missing = await app.inject({ method: 'DELETE', url: '/api/policies/pol_missing' });
    expect(missing.statusCode).toBe(404);
  });
});
