/**
 * Memory routes: view/edit/export memories and the global memory toggle.
 */
import { MEMORY_KINDS } from '@jarvis/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SETTING_KEYS, type AppContext } from '../context.js';
import { badRequest } from '../lib/http-errors.js';

const CreateBody = z.object({
  kind: z.enum(MEMORY_KINDS),
  content: z.string().min(1).max(10_000),
});

/** Accepts JSON booleans plus SQLite-style 0/1, normalized to a boolean. */
const BoolLike = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((v) => v === true || v === 1);

const PatchBody = z.object({
  content: z.string().min(1).max(10_000).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  enabled: BoolLike.optional(),
});

const SettingsBody = z.object({ enabled: z.boolean() });

export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { memory, settings, audit } = ctx.services;

  app.get('/api/memory', async (request) => {
    const [items, enabled] = await Promise.all([
      memory.list(request.workspaceId, { includeDisabled: true }),
      memory.isEnabled(request.workspaceId),
    ]);
    return { items, enabled };
  });

  app.post('/api/memory', { config: { idempotent: true } }, async (request) => {
    const body = CreateBody.safeParse(request.body);
    if (!body.success) throw badRequest('kind and content are required');
    const entry = await memory.create(request.workspaceId, request.userId, {
      kind: body.data.kind,
      content: body.data.content,
      origin: 'explicit',
    });
    return { memory: entry };
  });

  app.patch('/api/memory/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = PatchBody.safeParse(request.body);
    if (!body.success) throw badRequest('Invalid memory patch');
    const patch: { content?: string; kind?: (typeof MEMORY_KINDS)[number]; enabled?: number } = {};
    if (body.data.content !== undefined) patch.content = body.data.content;
    if (body.data.kind !== undefined) patch.kind = body.data.kind;
    if (body.data.enabled !== undefined) patch.enabled = body.data.enabled ? 1 : 0;
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to update');
    const entry = await memory.update(request.workspaceId, id, patch);
    return { memory: entry };
  });

  app.delete('/api/memory/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await memory.remove(request.workspaceId, id);
    return { ok: true };
  });

  app.get('/api/memory/export', async (request) => {
    const items = await memory.exportAll(request.workspaceId);
    return { items };
  });

  app.put('/api/memory/settings', async (request) => {
    const body = SettingsBody.safeParse(request.body);
    if (!body.success) throw badRequest('enabled must be a boolean');
    await settings.set(request.workspaceId, SETTING_KEYS.memoryEnabled, body.data.enabled);
    await audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'memory.toggled',
      actor: 'user',
      targetType: 'setting',
      targetId: SETTING_KEYS.memoryEnabled,
      summary: `Memory ${body.data.enabled ? 'enabled' : 'disabled'}`,
      metadata: { enabled: body.data.enabled },
    });
    return { enabled: body.data.enabled };
  });
}
