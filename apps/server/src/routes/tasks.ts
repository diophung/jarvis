/**
 * Task routes (see docs/api-contract.md "Tasks (prioritized items)"):
 * prioritized task candidates, manual rescore, status updates, and feedback.
 */
import {
  FEEDBACK_KINDS,
  fromJson,
  nowIso,
  PLANNING_CATEGORIES,
  TASK_CANDIDATE_STATUSES,
} from '@donna/core';
import type { Level, PlanningCategory, ScoreSignal, TaskCandidate } from '@donna/core';
import type { TaskCandidatesTable } from '@donna/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

export function parseTaskCandidateRow(row: TaskCandidatesTable): TaskCandidate {
  return {
    ...row,
    status: row.status as TaskCandidate['status'],
    priorityLevel: row.priorityLevel as Level,
    urgencyLevel: row.urgencyLevel as Level,
    effortLevel: row.effortLevel as Level,
    planningCategory: row.planningCategory as PlanningCategory,
    signals: fromJson<ScoreSignal[]>(row.signals, []),
    peopleIds: fromJson<string[]>(row.peopleIds, []),
    origin: row.origin as TaskCandidate['origin'],
  };
}

const TasksQuerySchema = z.object({
  status: z.enum(TASK_CANDIDATE_STATUSES).optional(),
  category: z.enum(PLANNING_CATEGORIES).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const isParseableDate = (value: string): boolean => !Number.isNaN(Date.parse(value));

const PatchTaskSchema = z.object({
  status: z.enum(TASK_CANDIDATE_STATUSES).optional(),
  deferredUntil: z
    .string()
    .refine(isParseableDate, { message: 'deferredUntil must be an ISO-8601 timestamp' })
    .nullable()
    .optional(),
});

const FeedbackSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  sourceItemId: z.string().min(1).optional(),
  taskCandidateId: z.string().min(1).optional(),
  digestItemId: z.string().min(1).optional(),
  note: z.string().max(2000).optional(),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const { scoring, feedback } = ctx.services;

  app.get('/api/tasks', async (request) => {
    const query = TasksQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      throw badRequest(
        `Invalid query: ${query.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    let q = db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .where('status', '=', query.data.status ?? 'open')
      .orderBy('overallScore', 'desc')
      .orderBy('createdAt', 'desc')
      .limit(Math.min(query.data.limit ?? 100, 200));
    if (query.data.category !== undefined) {
      q = q.where('planningCategory', '=', query.data.category);
    }
    const rows = await q.execute();
    return { items: rows.map(parseTaskCandidateRow) };
  });

  app.post('/api/tasks/rescore', async (request) => {
    const { scored } = await scoring.rescoreWorkspace(request.workspaceId);
    return { scored };
  });

  app.patch('/api/tasks/:id', async (request) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) throw badRequest('Invalid task id');
    const body = PatchTaskSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw badRequest(
        `Invalid task update: ${body.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    const existing = await db
      .selectFrom('taskCandidates')
      .select('id')
      .where('workspaceId', '=', request.workspaceId)
      .where('id', '=', params.data.id)
      .executeTakeFirst();
    if (!existing) throw notFound('Task not found');

    const patch: Partial<TaskCandidatesTable> = { updatedAt: nowIso() };
    if (body.data.status !== undefined) patch.status = body.data.status;
    if (body.data.deferredUntil !== undefined) patch.deferredUntil = body.data.deferredUntil;
    await db.updateTable('taskCandidates').set(patch).where('id', '=', existing.id).execute();

    const row = await db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirstOrThrow();
    return { task: parseTaskCandidateRow(row) };
  });

  app.post('/api/feedback', { config: { idempotent: true } }, async (request) => {
    const body = FeedbackSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw badRequest(
        `Invalid feedback: ${body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    await feedback.record(request.workspaceId, request.userId, body.data);
    return { ok: true };
  });
}
