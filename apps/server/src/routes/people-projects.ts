/**
 * People & projects routes (see docs/api-contract.md "People & projects").
 * These are the priority-context entities the scoring engine reads.
 */
import { fromJson, newId, nowIso, PERSON_IMPORTANCES, toJson } from '@jarvis/core';
import type { Person, Project } from '@jarvis/core';
import type { PeopleTable, ProjectsTable } from '@jarvis/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

export function parsePersonRow(row: PeopleTable): Person {
  return {
    ...row,
    emails: fromJson<string[]>(row.emails, []),
    handles: fromJson<string[]>(row.handles, []),
    importance: row.importance as Person['importance'],
    origin: row.origin as Person['origin'],
  };
}

export function parseProjectRow(row: ProjectsTable): Project {
  return {
    ...row,
    status: row.status as Project['status'],
    priority: row.priority as Project['priority'],
    keywords: fromJson<string[]>(row.keywords, []),
    stakeholderPeopleIds: fromJson<string[]>(row.stakeholderPeopleIds, []),
    origin: row.origin as Project['origin'],
  };
}

const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
const PROJECT_PRIORITIES = ['high', 'normal', 'low'] as const;

const PatchPersonSchema = z.object({
  importance: z.enum(PERSON_IMPORTANCES).optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  keywords: z.array(z.string().min(1).max(100)).max(50).optional(),
});

const PatchProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  priority: z.enum(PROJECT_PRIORITIES).optional(),
  keywords: z.array(z.string().min(1).max(100)).max(50).optional(),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export function registerPeopleProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const { audit } = ctx.services;

  // -- People ----------------------------------------------------------------

  app.get('/api/people', async (request) => {
    const rows = await db
      .selectFrom('people')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('displayName', 'asc')
      .execute();
    return { items: rows.map(parsePersonRow) };
  });

  app.patch('/api/people/:id', async (request) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) throw badRequest('Invalid person id');
    const body = PatchPersonSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw badRequest(
        `Invalid person update: ${body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    const existing = await db
      .selectFrom('people')
      .select(['id', 'displayName'])
      .where('workspaceId', '=', request.workspaceId)
      .where('id', '=', params.data.id)
      .executeTakeFirst();
    if (!existing) throw notFound('Person not found');

    const patch: Partial<PeopleTable> = { updatedAt: nowIso() };
    if (body.data.importance !== undefined) patch.importance = body.data.importance;
    if (body.data.notes !== undefined) patch.notes = body.data.notes;
    await db.updateTable('people').set(patch).where('id', '=', existing.id).execute();

    await audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'preference.updated',
      actor: 'user',
      targetType: 'person',
      targetId: existing.id,
      summary: `Person importance changed: ${existing.displayName}`,
      metadata: {
        personId: existing.id,
        ...(body.data.importance !== undefined ? { importance: body.data.importance } : {}),
        notesChanged: body.data.notes !== undefined,
      },
    });

    const row = await db
      .selectFrom('people')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirstOrThrow();
    return { person: parsePersonRow(row) };
  });

  // -- Projects ----------------------------------------------------------------

  app.get('/api/projects', async (request) => {
    const rows = await db
      .selectFrom('projects')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
    return { items: rows.map(parseProjectRow) };
  });

  app.post('/api/projects', async (request) => {
    const body = CreateProjectSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw badRequest(
        `Invalid project: ${body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const now = nowIso();
    const id = newId('prj');
    await db
      .insertInto('projects')
      .values({
        id,
        workspaceId: request.workspaceId,
        name: body.data.name,
        description: body.data.description ?? null,
        status: 'active',
        priority: body.data.priority ?? 'normal',
        keywords: toJson(body.data.keywords ?? []),
        stakeholderPeopleIds: toJson([]),
        dueAt: null,
        origin: 'user',
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    const row = await db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { project: parseProjectRow(row) };
  });

  app.patch('/api/projects/:id', async (request) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) throw badRequest('Invalid project id');
    const body = PatchProjectSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw badRequest(
        `Invalid project update: ${body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    const existing = await db
      .selectFrom('projects')
      .select('id')
      .where('workspaceId', '=', request.workspaceId)
      .where('id', '=', params.data.id)
      .executeTakeFirst();
    if (!existing) throw notFound('Project not found');

    const patch: Partial<ProjectsTable> = { updatedAt: nowIso() };
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.description !== undefined) patch.description = body.data.description;
    if (body.data.status !== undefined) patch.status = body.data.status;
    if (body.data.priority !== undefined) patch.priority = body.data.priority;
    if (body.data.keywords !== undefined) patch.keywords = toJson(body.data.keywords);
    await db.updateTable('projects').set(patch).where('id', '=', existing.id).execute();

    const row = await db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirstOrThrow();
    return { project: parseProjectRow(row) };
  });
}
