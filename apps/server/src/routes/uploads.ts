/**
 * Upload routes (contract: docs/api-contract.md "Uploads").
 * The integrated app registers @fastify/multipart globally (25MB limit);
 * these handlers consume the parsed multipart file via request.file().
 */
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

const IdParams = z.object({ id: z.string().min(1) });

export function registerUploadsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { uploads } = ctx.services;

  app.post('/api/uploads', async (request) => {
    const mp: MultipartFile | undefined = await request.file();
    if (mp === undefined) throw badRequest('multipart "file" field is required');
    const data = await mp.toBuffer();
    const file = await uploads.handleUpload(request.workspaceId, request.userId, {
      filename: mp.filename,
      mimeType: mp.mimetype === '' ? null : mp.mimetype,
      data,
    });
    return { file };
  });

  app.get('/api/uploads', async (request) => ({
    items: await uploads.list(request.workspaceId),
  }));

  app.get('/api/uploads/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const file = await uploads.get(request.workspaceId, id);
    if (file === null) throw notFound('Uploaded file not found');
    return { file };
  });

  app.get('/api/uploads/:id/text', async (request) => {
    const { id } = IdParams.parse(request.params);
    const file = await uploads.get(request.workspaceId, id);
    if (file === null) throw notFound('Uploaded file not found');
    return { text: await uploads.getText(request.workspaceId, id) };
  });

  app.delete('/api/uploads/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const file = await uploads.get(request.workspaceId, id);
    if (file === null) throw notFound('Uploaded file not found');
    await uploads.remove(request.workspaceId, id);
    return { ok: true };
  });
}
