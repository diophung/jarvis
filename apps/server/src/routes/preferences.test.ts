import { createDefaultRegistry } from '@jarvis/connectors';
import type { Db } from '@jarvis/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerPreferenceRoutes } from './preferences.js';

let db: Db;
let workspaceId: string;
let userId: string;
let app: FastifyInstance;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const ctx: AppContext = {
    config: {} as AppConfig,
    db,
    connectors: createDefaultRegistry(),
    services: { audit } as Partial<Services> as Services,
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
  registerPreferenceRoutes(app, ctx);
});

describe('preferences routes', () => {
  it('round-trips PUT -> GET -> PUT (update) -> DELETE', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/preferences/people.vip',
      payload: { value: ['sarah@meridianlabs.example', 'jin@meridianlabs.example'] },
    });
    expect(put.statusCode).toBe(200);
    const pref = put.json().preference;
    expect(pref.key).toBe('people.vip');
    expect(pref.value).toEqual(['sarah@meridianlabs.example', 'jin@meridianlabs.example']);
    expect(pref.kind).toBe('explicit');
    expect(pref.origin).toBe('user');

    const list = await app.inject({ method: 'GET', url: '/api/preferences' });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].value).toEqual([
      'sarah@meridianlabs.example',
      'jin@meridianlabs.example',
    ]);

    // Upsert keeps the same row.
    const put2 = await app.inject({
      method: 'PUT',
      url: '/api/preferences/people.vip',
      payload: { value: ['sarah@meridianlabs.example'] },
    });
    expect(put2.json().preference.id).toBe(pref.id);
    expect(put2.json().preference.value).toEqual(['sarah@meridianlabs.example']);
    const list2 = await app.inject({ method: 'GET', url: '/api/preferences' });
    expect(list2.json().items).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: '/api/preferences/people.vip' });
    expect(del.json()).toEqual({ ok: true });
    const empty = await app.inject({ method: 'GET', url: '/api/preferences' });
    expect(empty.json().items).toHaveLength(0);

    const delAgain = await app.inject({ method: 'DELETE', url: '/api/preferences/people.vip' });
    expect(delAgain.statusCode).toBe(404);

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'preference.updated')
      .execute();
    expect(audits.length).toBe(3); // two PUTs + one DELETE
  });

  it('stores object values and requires a value field', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/preferences/workingHours',
      payload: { value: { start: '09:00', end: '18:00' } },
    });
    expect(put.json().preference.value).toEqual({ start: '09:00', end: '18:00' });

    const missingValue = await app.inject({
      method: 'PUT',
      url: '/api/preferences/digest.time',
      payload: {},
    });
    expect(missingValue.statusCode).toBe(400);
  });
});
