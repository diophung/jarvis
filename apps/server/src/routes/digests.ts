/**
 * Digest routes: history, latest, fetch, synchronous generation, and the
 * digest schedule setting (consumed by the worker loop).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { SETTING_KEYS } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

export const DEFAULT_DIGEST_SCHEDULE = { cron: '0 7 * * *', enabled: true };

const ScheduleSchema = z.object({
  cron: z
    .string()
    .trim()
    .refine((value) => value.split(/\s+/).length === 5, {
      message: 'cron must have exactly 5 space-separated fields',
    }),
  enabled: z.boolean(),
});

const GenerateSchema = z.object({
  kind: z.enum(['daily', 'manual', 'scheduled']).optional(),
  supersedesDigestId: z.string().optional(),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

export function registerDigestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { digest, settings, audit } = ctx.services;

  app.get('/api/digests', async (request) => ({
    items: await digest.list(request.workspaceId),
  }));

  app.get('/api/digests/latest', async (request) => {
    const all = await digest.list(request.workspaceId);
    const latest = all.find((d) => d.status === 'ready');
    return {
      digest: latest !== undefined ? await digest.get(request.workspaceId, latest.id) : null,
    };
  });

  app.get('/api/digests/schedule', async (request) => ({
    schedule: await settings.get(
      request.workspaceId,
      SETTING_KEYS.digestSchedule,
      DEFAULT_DIGEST_SCHEDULE,
    ),
  }));

  app.put('/api/digests/schedule', async (request) => {
    const body = ScheduleSchema.safeParse(request.body ?? {});
    if (!body.success) {
      throw badRequest(
        `Invalid schedule: ${body.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    await settings.set(request.workspaceId, SETTING_KEYS.digestSchedule, body.data);
    await audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'settings.updated',
      actor: 'user',
      targetType: 'setting',
      targetId: SETTING_KEYS.digestSchedule,
      summary: 'Digest schedule updated',
      metadata: { cron: body.data.cron, enabled: body.data.enabled },
    });
    return { schedule: body.data };
  });

  app.post('/api/digests/generate', async (request) => {
    const body = GenerateSchema.safeParse(request.body ?? {});
    if (!body.success) throw badRequest('Invalid digest generation options');
    const opts: { kind: 'daily' | 'manual' | 'scheduled'; supersedesDigestId?: string } = {
      kind: body.data.kind ?? 'manual',
    };
    if (body.data.supersedesDigestId !== undefined) {
      opts.supersedesDigestId = body.data.supersedesDigestId;
    }
    const generated = await digest.generate(request.workspaceId, request.userId, opts);
    return { digest: generated };
  });

  app.get('/api/digests/:id', async (request) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) throw badRequest('Invalid digest id');
    const found = await digest.get(request.workspaceId, params.data.id);
    if (found === null) throw notFound('Digest not found');
    return { digest: found };
  });
}
