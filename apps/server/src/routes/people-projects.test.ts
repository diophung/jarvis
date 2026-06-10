import { createDefaultRegistry } from '@donna/connectors';
import { newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { AppContext, Services } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createAuditService } from '../services/audit.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { registerPeopleProjectRoutes } from './people-projects.js';

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
  app.setErrorHandler((err, _request, reply) => {
    const status = err instanceof HttpError ? err.statusCode : 500;
    const code = err instanceof HttpError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    void reply.code(status).send({ error: { code, message } });
  });
  registerPeopleProjectRoutes(app, ctx);
});

async function insertPerson(displayName: string, emails: string[]): Promise<string> {
  const id = newId('per');
  const now = nowIso();
  await db
    .insertInto('people')
    .values({
      id,
      workspaceId,
      displayName,
      emails: toJson(emails),
      handles: toJson(['@handle']),
      organizationId: null,
      title: null,
      importance: 'normal',
      isSelf: 0,
      interactionCount: 3,
      lastInteractionAt: null,
      notes: null,
      origin: 'observed',
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

describe('people routes', () => {
  it('lists people with parsed json fields', async () => {
    await insertPerson('Sarah Chen', ['sarah@meridianlabs.example']);
    const res = await app.inject({ method: 'GET', url: '/api/people' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].emails).toEqual(['sarah@meridianlabs.example']);
    expect(items[0].handles).toEqual(['@handle']);
    expect(items[0].importance).toBe('normal');
  });

  it('PATCH validates importance, updates notes, and audits', async () => {
    const personId = await insertPerson('Sarah Chen', ['sarah@meridianlabs.example']);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/people/${personId}`,
      payload: { importance: 'vip', notes: 'CEO — always prioritize' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().person.importance).toBe('vip');
    expect(patch.json().person.notes).toBe('CEO — always prioritize');

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/people/${personId}`,
      payload: { importance: 'super-vip' },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/people/per_missing',
      payload: { importance: 'low' },
    });
    expect(missing.statusCode).toBe(404);

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'preference.updated')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary).toContain('Person importance changed');
    expect(audits[0]!.targetId).toBe(personId);
  });
});

describe('project routes', () => {
  it('creates, lists, and patches projects with parsed keywords', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Apollo Launch', priority: 'high', keywords: ['apollo', 'launch'] },
    });
    expect(created.statusCode).toBe(200);
    const project = created.json().project;
    expect(project.name).toBe('Apollo Launch');
    expect(project.priority).toBe('high');
    expect(project.status).toBe('active');
    expect(project.keywords).toEqual(['apollo', 'launch']);
    expect(project.origin).toBe('user');

    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].keywords).toEqual(['apollo', 'launch']);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { status: 'paused', priority: 'low', keywords: ['apollo'], description: 'on hold' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().project).toMatchObject({
      status: 'paused',
      priority: 'low',
      keywords: ['apollo'],
      description: 'on hold',
    });
  });

  it('validates enums and missing ids', async () => {
    const noName = await app.inject({ method: 'POST', url: '/api/projects', payload: {} });
    expect(noName.statusCode).toBe(400);

    const badPriority = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'X', priority: 'urgent' },
    });
    expect(badPriority.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Y' },
    });
    const projectId = created.json().project.id;

    const badStatus = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { status: 'cancelled' },
    });
    expect(badStatus.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/projects/prj_missing',
      payload: { name: 'Z' },
    });
    expect(missing.statusCode).toBe(404);
  });
});
