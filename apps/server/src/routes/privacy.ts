/**
 * Privacy routes: full account data export and the "delete all my data"
 * path. Deletion is a durable, worker-processed job: requesting returns the
 * tracked request; status is pollable; the purge itself is audited.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerPrivacyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { privacy } = ctx.services;

  app.get('/api/account/export', async (request, reply) => {
    const data = await privacy.exportAccountData(request.workspaceId, request.userId);
    reply.header('content-disposition', 'attachment; filename="jarvis-account-export.json"');
    return data;
  });

  app.post('/api/account/delete-data', { config: { idempotent: true } }, async (request) => {
    const deletion = await privacy.requestDeletion(request.workspaceId, request.userId);
    return { request: deletion };
  });

  app.get('/api/account/delete-data', async (request) => {
    const status = await privacy.getDeletionStatus(request.workspaceId);
    return { request: status };
  });
}
