import type { Db } from '@donna/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdempotencyService } from '../context.js';
import { registerIdempotencyHooks } from '../lib/idempotency-hooks.js';
import { createIdempotencyService, hashRequestBody } from './idempotency.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';

let db: Db;
let workspaceId: string;
let userId: string;
let idempotency: IdempotencyService;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  idempotency = createIdempotencyService({ db });
});

describe('idempotency service', () => {
  it('first begin proceeds; completed keys replay the stored response', async () => {
    const hash = hashRequestBody({ a: 1 });
    const first = await idempotency.begin(workspaceId, userId, 'POST /x', 'key-1', hash);
    expect(first.kind).toBe('proceed');
    if (first.kind !== 'proceed') throw new Error('unreachable');
    await first.complete(200, { ok: true });

    const second = await idempotency.begin(workspaceId, userId, 'POST /x', 'key-1', hash);
    expect(second.kind).toBe('replay');
    if (second.kind !== 'replay') throw new Error('unreachable');
    expect(second.responseStatus).toBe(200);
    expect(JSON.parse(second.responseBody ?? '')).toEqual({ ok: true });
  });

  it('rejects key reuse with a different request body', async () => {
    const first = await idempotency.begin(
      workspaceId,
      userId,
      'POST /x',
      'key-2',
      hashRequestBody({ a: 1 }),
    );
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await first.complete(200, { ok: true });
    const reused = await idempotency.begin(
      workspaceId,
      userId,
      'POST /x',
      'key-2',
      hashRequestBody({ a: 2 }),
    );
    expect(reused.kind).toBe('key_reuse_conflict');
  });

  it('flags concurrent in-flight duplicates', async () => {
    const hash = hashRequestBody({ a: 1 });
    const first = await idempotency.begin(workspaceId, userId, 'POST /x', 'key-3', hash);
    expect(first.kind).toBe('proceed');
    const duplicate = await idempotency.begin(workspaceId, userId, 'POST /x', 'key-3', hash);
    expect(duplicate.kind).toBe('in_flight_conflict');
  });

  it('abandon frees the key so the client can retry after a failure', async () => {
    const hash = hashRequestBody({ a: 1 });
    const first = await idempotency.begin(workspaceId, userId, 'POST /x', 'key-4', hash);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await first.abandon();
    const retry = await idempotency.begin(workspaceId, userId, 'POST /x', 'key-4', hash);
    expect(retry.kind).toBe('proceed');
  });

  it('keys are tenant-scoped: the same key in another workspace proceeds', async () => {
    const other = await seedWorkspace(db);
    const hash = hashRequestBody({ a: 1 });
    const first = await idempotency.begin(workspaceId, userId, 'POST /x', 'shared', hash);
    if (first.kind !== 'proceed') throw new Error('expected proceed');
    await first.complete(200, { ok: true });
    const cross = await idempotency.begin(other.workspaceId, other.userId, 'POST /x', 'shared', hash);
    expect(cross.kind).toBe('proceed');
  });

  it('cleanupExpired removes only expired records', async () => {
    const hash = hashRequestBody({});
    const live = await idempotency.begin(workspaceId, userId, 'POST /x', 'live', hash);
    if (live.kind !== 'proceed') throw new Error('expected proceed');
    await live.complete(200, {});
    await db
      .updateTable('idempotencyKeys')
      .set({ expiresAt: '2000-01-01T00:00:00.000Z' })
      .where('key', '=', 'live')
      .execute();
    const removed = await idempotency.cleanupExpired();
    expect(removed).toBe(1);
  });
});

describe('idempotency HTTP hooks', () => {
  let app: FastifyInstance;
  let executions: number;

  beforeEach(async () => {
    executions = 0;
    app = fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('workspaceId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = userId;
      request.workspaceId = workspaceId;
    });
    registerIdempotencyHooks(app, idempotency);
    app.post('/api/thing', { config: { idempotent: true } }, async () => {
      executions += 1;
      return { created: executions };
    });
    app.post('/api/boom', { config: { idempotent: true } }, async (_req, reply) => {
      executions += 1;
      return reply.code(500).send({ error: 'kaboom' });
    });
  });

  it('replays the stored response for a retried request without re-executing', async () => {
    const payload = { name: 'x' };
    const headers = { 'idempotency-key': 'abc' };
    const first = await app.inject({ method: 'POST', url: '/api/thing', payload, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ created: 1 });

    const retry = await app.inject({ method: 'POST', url: '/api/thing', payload, headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ created: 1 }); // same response, no second write
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(executions).toBe(1);
  });

  it('409s when the key is reused with a different body', async () => {
    const headers = { 'idempotency-key': 'reuse' };
    await app.inject({ method: 'POST', url: '/api/thing', payload: { a: 1 }, headers });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/thing',
      payload: { a: 2 },
      headers,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_key_reuse');
  });

  it('does not store 5xx responses — the retry re-executes', async () => {
    const headers = { 'idempotency-key': 'crash' };
    const first = await app.inject({ method: 'POST', url: '/api/boom', payload: {}, headers });
    expect(first.statusCode).toBe(500);
    const retry = await app.inject({ method: 'POST', url: '/api/boom', payload: {}, headers });
    expect(retry.statusCode).toBe(500);
    expect(executions).toBe(2);
  });

  it('requests without the header behave normally', async () => {
    await app.inject({ method: 'POST', url: '/api/thing', payload: {} });
    await app.inject({ method: 'POST', url: '/api/thing', payload: {} });
    expect(executions).toBe(2);
  });
});
