import { createDefaultRegistry } from '@jarvis/connectors';
import { newId, nowIso, toJson } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { createMockAdapter, LlmClient } from '@jarvis/llm';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type {
  ActionsService,
  AppContext,
  LlmRouterService,
  MemoryService,
  RetrievalService,
  Services,
} from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAssistantService } from '../services/assistant.js';
import { createAuditService } from '../services/audit.js';
import { createSettingsService } from '../services/settings.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerConversationsRoutes } from './conversations.js';

let db: Db;
let workspaceId: string;
let userId: string;
let app: FastifyInstance;

function makeLlmStub(): LlmRouterService {
  return {
    clientForTask: async () => ({
      client: new LlmClient(createMockAdapter()),
      model: 'mock-model',
      params: {},
      providerConfigId: null,
      providerName: 'Demo',
      kind: 'mock',
      isLocal: true,
      isMock: true,
    }),
    embeddingClient: async () => null,
    healthCheck: async () => ({ ok: true, latencyMs: 0, message: 'ok' }),
    listModels: async () => [],
    status: async () => ({
      demoMode: true,
      tasks: { chat: null, summarization: null, digest: null, classification: null, embedding: null },
    }),
  };
}

function makeMemoryStub(): MemoryService {
  return {
    isEnabled: async () => false,
    list: async () => [],
    create: async () => {
      throw new Error('not implemented');
    },
    update: async () => {
      throw new Error('not implemented');
    },
    remove: async () => {},
    exportAll: async () => [],
    relevant: async () => [],
  };
}

function makeActionsStub(): ActionsService {
  return {
    propose: async () => {
      throw new Error('not implemented');
    },
    execute: async () => {
      throw new Error('not implemented');
    },
    decideApproval: async () => {
      throw new Error('not implemented');
    },
    listApprovals: async () => [],
    riskFor: () => 'low',
  };
}

const retrievalStub: RetrievalService = {
  search: async () => ({ results: [], mode: 'keyword' }),
};

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;

  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  const assistant = createAssistantService({
    db,
    llm: makeLlmStub(),
    retrieval: retrievalStub,
    memory: makeMemoryStub(),
    actions: makeActionsStub(),
    settings,
    audit,
  });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit, settings, assistant } as Partial<Services> as Services,
  };
  app = fastify();
  app.decorateRequest('userId', '');
  app.decorateRequest('workspaceId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
    request.workspaceId = workspaceId;
  });
  app.setErrorHandler((err: unknown, _request, reply) => {
    const status = err instanceof HttpError ? err.statusCode : 500;
    const code = err instanceof HttpError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    void reply.code(status).send({ error: { code, message } });
  });
  registerConversationsRoutes(app, ctx);
});

describe('conversation CRUD', () => {
  it('creates conversations with a default title and lists non-archived most recent first', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    expect(a.statusCode).toBe(200);
    expect(a.json().conversation.title).toBe('New conversation');
    expect(a.json().conversation.pinned).toBe(0);

    const b = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { title: 'Budget questions' },
    });
    expect(b.json().conversation.title).toBe('Budget questions');

    // Give A recent activity so it sorts first; archive a third conversation.
    await db
      .updateTable('conversations')
      .set({ lastMessageAt: nowIso() })
      .where('id', '=', a.json().conversation.id)
      .execute();
    const c = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { title: 'Archived one' },
    });
    await db
      .updateTable('conversations')
      .set({ archived: 1 })
      .where('id', '=', c.json().conversation.id)
      .execute();

    const list = await app.inject({ method: 'GET', url: '/api/conversations' });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as { id: string }[];
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe(a.json().conversation.id);
    expect(items[1]?.id).toBe(b.json().conversation.id);
  });

  it('gets a conversation with messages ascending and parsed JSON fields', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const id = created.json().conversation.id as string;
    const now = nowIso();
    await db
      .insertInto('messages')
      .values([
        {
          id: newId('msg'),
          conversationId: id,
          workspaceId,
          role: 'user',
          content: 'first',
          citations: toJson([]),
          suggestedActions: toJson([]),
          status: 'complete',
          modelUsed: null,
          llmCallId: null,
          error: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: newId('msg'),
          conversationId: id,
          workspaceId,
          role: 'assistant',
          content: 'second',
          citations: toJson([
            { sourceType: 'source_item', refId: 'itm_1', title: 'An email', snippet: 'hello' },
          ]),
          suggestedActions: toJson([
            { type: 'mark_done', label: 'Mark done', payload: { taskCandidateId: 'tsk_1' } },
          ]),
          status: 'complete',
          modelUsed: 'mock-model',
          llmCallId: null,
          error: null,
          createdAt: now,
        },
      ])
      .execute();

    const res = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversation.id).toBe(id);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe('first');
    expect(body.messages[1].citations).toEqual([
      { sourceType: 'source_item', refId: 'itm_1', title: 'An email', snippet: 'hello' },
    ]);
    expect(body.messages[1].suggestedActions[0].type).toBe('mark_done');

    const missing = await app.inject({ method: 'GET', url: '/api/conversations/cnv_missing' });
    expect(missing.statusCode).toBe(404);
  });

  it('patches title/pinned/archived and deletes conversations with their messages', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const id = created.json().conversation.id as string;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      payload: { title: 'Renamed', pinned: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().conversation.title).toBe('Renamed');
    expect(patched.json().conversation.pinned).toBe(1);

    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      payload: { archived: true },
    });
    expect(archived.json().conversation.archived).toBe(1);

    await db
      .insertInto('messages')
      .values({
        id: newId('msg'),
        conversationId: id,
        workspaceId,
        role: 'user',
        content: 'to be deleted',
        citations: toJson([]),
        suggestedActions: toJson([]),
        status: 'complete',
        modelUsed: null,
        llmCallId: null,
        error: null,
        createdAt: nowIso(),
      })
      .execute();

    const del = await app.inject({ method: 'DELETE', url: `/api/conversations/${id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });
    const remaining = await db
      .selectFrom('messages')
      .selectAll()
      .where('conversationId', '=', id)
      .execute();
    expect(remaining).toHaveLength(0);
    const gone = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    expect(gone.statusCode).toBe(404);

    const badPatch = await app.inject({
      method: 'PATCH',
      url: '/api/conversations/cnv_missing',
      payload: { title: 'x' },
    });
    expect(badPatch.statusCode).toBe(404);
  });
});

describe('POST /api/conversations/:id/messages (SSE)', () => {
  it('validates content and 404s on unknown conversations', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const id = created.json().conversation.id as string;

    const empty = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      payload: { content: '' },
    });
    expect(empty.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/conversations/cnv_missing/messages',
      payload: { content: 'hello' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('persists the user message and streams delta/citations/actions/message SSE frames', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
    const id = created.json().conversation.id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      payload: { content: 'What needs my attention today?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: delta');
    expect(res.body).toContain('event: citations');
    expect(res.body).toContain('event: actions');
    expect(res.body).toContain('event: message');

    const rows = await db
      .selectFrom('messages')
      .selectAll()
      .where('conversationId', '=', id)
      .orderBy('createdAt', 'asc')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.role).toBe('user');
    expect(rows[0]?.content).toBe('What needs my attention today?');
    expect(rows[1]?.role).toBe('assistant');
    expect(rows[1]?.status).toBe('complete');

    // The final message frame carries the persisted assistant message.
    const messageFrame = res.body
      .split('\n\n')
      .find((frame) => frame.startsWith('event: message'));
    expect(messageFrame).toBeDefined();
    const data = JSON.parse(messageFrame?.split('\ndata: ')[1] ?? '{}') as {
      message?: { id: string; content: string };
    };
    expect(data.message?.id).toBe(rows[1]?.id);
    expect(data.message?.content).toContain('Demo mode');
  });
});
