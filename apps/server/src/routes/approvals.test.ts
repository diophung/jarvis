import { newId, nowIso, toJson } from '@jarvis/core';
import { createDefaultRegistry } from '@jarvis/connectors';
import type { Db } from '@jarvis/db';
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
import { registerApprovalRoutes } from './approvals.js';

let db: Db;
let workspaceId: string;
let userId: string;
let actions: ActionsService;
let app: FastifyInstance;

function buildApp(ctx: AppContext): FastifyInstance {
  const instance = fastify();
  instance.decorateRequest('userId', '');
  instance.decorateRequest('workspaceId', '');
  instance.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  instance.setErrorHandler((err: Error, _request, reply) => {
    const status = err instanceof HttpError ? err.statusCode : 500;
    const code = err instanceof HttpError ? err.code : 'error';
    void reply.code(status).send({ error: { code, message: err.message } });
  });
  registerApprovalRoutes(instance, ctx);
  return instance;
}

async function seedMockEmailAccount(): Promise<string> {
  const now = nowIso();
  const id = newId('acc');
  await db
    .insertInto('sourceAccounts')
    .values({
      id,
      workspaceId,
      userId,
      provider: 'mock-email',
      category: 'email',
      displayName: 'Demo Email',
      status: 'connected',
      authRef: null,
      scopes: toJson([]),
      capabilities: toJson(['read', 'list', 'search', 'send']),
      settings: toJson({}),
      lastSyncAt: null,
      syncCursor: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

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
    services: { actions, audit, settings, memory } as Partial<Services> as Services,
  };
  app = buildApp(ctx);
});

async function proposeEmailSend(accountId: string) {
  return actions.propose({
    workspaceId,
    userId,
    capability: 'email.send',
    actionType: 'send_email',
    params: { to: 'jin@example.com', subject: 'Budget', body: 'Numbers attached.' },
    target: { provider: 'mock-email', accountId },
    reason: 'User asked Jarvis to send the budget',
    preview: { summary: 'Send budget email to Jin' },
  });
}

describe('GET /api/approvals', () => {
  it('lists approvals with a status filter and parsed preview', async () => {
    const accountId = await seedMockEmailAccount();
    const { approval } = await proposeEmailSend(accountId);
    const res = await app.inject({ method: 'GET', url: '/api/approvals?status=pending' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(approval?.id);
    expect(body.items[0].preview).toEqual({ summary: 'Send budget email to Jin' });

    const none = await app.inject({ method: 'GET', url: '/api/approvals?status=approved' });
    expect(none.json().items).toHaveLength(0);

    const bad = await app.inject({ method: 'GET', url: '/api/approvals?status=banana' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /api/approvals/:id/decide', () => {
  it('approve returns the approval and the executed action', async () => {
    const accountId = await seedMockEmailAccount();
    const { approval } = await proposeEmailSend(accountId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval?.id}/decide`,
      payload: { decision: 'approve', note: 'ship it' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approval.status).toBe('approved');
    expect(body.approval.decisionNote).toBe('ship it');
    expect(body.action.status).toBe('executed');
    expect(body.action.result.externalRef).toContain('mock-email-sent-');
  });

  it('deny returns the denied approval and action', async () => {
    const accountId = await seedMockEmailAccount();
    const { approval } = await proposeEmailSend(accountId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval?.id}/decide`,
      payload: { decision: 'deny' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.approval.status).toBe('denied');
    expect(body.action.status).toBe('denied');
  });

  it('validates the body and 404s on unknown approvals', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/approvals/apr_x/decide',
      payload: { decision: 'maybe' },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/approvals/apr_missing/decide',
      payload: { decision: 'approve' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('409s when deciding twice', async () => {
    const accountId = await seedMockEmailAccount();
    const { approval } = await proposeEmailSend(accountId);
    await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval?.id}/decide`,
      payload: { decision: 'deny' },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval?.id}/decide`,
      payload: { decision: 'approve' },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('GET /api/actions', () => {
  it('lists actions with status filter and limit', async () => {
    const accountId = await seedMockEmailAccount();
    const { approval } = await proposeEmailSend(accountId);
    await actions.propose({
      workspaceId,
      userId,
      capability: 'source.read',
      actionType: 'read',
      params: {},
      target: {},
      reason: 'read',
      preview: { summary: 'Read inbox' },
    });

    const all = await app.inject({ method: 'GET', url: '/api/actions' });
    expect(all.json().items).toHaveLength(2);
    // Parsed JSON fields, not strings.
    expect(typeof all.json().items[0].params).toBe('object');

    const awaiting = await app.inject({ method: 'GET', url: '/api/actions?status=awaiting_approval' });
    expect(awaiting.json().items).toHaveLength(1);
    expect(awaiting.json().items[0].approvalRequestId).toBe(approval?.id);

    const limited = await app.inject({ method: 'GET', url: '/api/actions?limit=1' });
    expect(limited.json().items).toHaveLength(1);

    const bad = await app.inject({ method: 'GET', url: '/api/actions?status=nope' });
    expect(bad.statusCode).toBe(400);
  });
});
