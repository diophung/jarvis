/**
 * Audit log + app settings routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/http-errors.js';

const AuditQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  before: z.string().optional(),
  eventType: z.string().optional(),
  actor: z.string().optional(),
});

/** Settings keys must live under a known namespace. */
const ALLOWED_SETTING_PREFIXES = ['digest.', 'memory.', 'sync.', 'assistant.'] as const;

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/audit', async (request) => {
    const query = AuditQuery.safeParse(request.query);
    if (!query.success) throw badRequest('Invalid audit query');
    const items = await ctx.services.audit.list(request.workspaceId, query.data);
    return { items };
  });

  app.get('/api/settings', async (request) => {
    const settings = await ctx.services.settings.getAll(request.workspaceId);
    return { settings };
  });

  app.put('/api/settings/:key', async (request) => {
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(request.params);
    if (!ALLOWED_SETTING_PREFIXES.some((p) => key.startsWith(p))) {
      throw badRequest(`Unknown settings key '${key}'`, 'unknown_setting');
    }
    const body = request.body;
    if (typeof body !== 'object' || body === null || !('value' in body)) {
      throw badRequest("Request body must include 'value'");
    }
    const value = (body as Record<string, unknown>).value;
    await ctx.services.settings.set(request.workspaceId, key, value);
    await ctx.services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'settings.updated',
      actor: 'user',
      targetType: 'setting',
      targetId: key,
      summary: `Setting '${key}' updated`,
      metadata: { key, value },
    });
    return { ok: true };
  });
}
