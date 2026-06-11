import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerAuth } from './auth.js';
import { registerAuthOauthRoutes } from './routes/auth-oauth.js';
import { registerSourceOauthRoutes } from './routes/source-oauth.js';
import { createSessionsService } from './services/sessions.js';
import type { AppContext } from './context.js';
import { HttpError } from './lib/http-errors.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerConversationsRoutes } from './routes/conversations.js';
import { registerDigestRoutes } from './routes/digests.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLlmRoutes } from './routes/llm.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerPeopleProjectRoutes } from './routes/people-projects.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerPreferenceRoutes } from './routes/preferences.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerSourcesRoutes } from './routes/sources.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerUploadsRoutes } from './routes/uploads.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.env.DONNA_LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: ctx.config.env.DONNA_TRUST_PROXY,
  });

  await app.register(cookie, { secret: ctx.config.env.DONNA_SECRET });
  await app.register(cors, {
    origin: [ctx.config.env.DONNA_WEB_ORIGIN],
    credentials: true,
  });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 413) {
      reply
        .code(413)
        .send({ error: { code: 'too_large', message: 'File exceeds the 25 MB limit' } });
      return;
    }
    const e = err as { message?: string; name?: string };
    app.log.error({ err: { message: e.message, name: e.name } }, 'unhandled error');
    // Never leak internals or sensitive content in error responses.
    reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  // One shared sessions service: the auth hook, password login, and OAuth
  // login must all mint/validate cookie tokens identically.
  const sessions = createSessionsService(ctx.db);
  registerAuth(app, { db: ctx.db, config: ctx.config, audit: ctx.services.audit, sessions });
  registerAuthOauthRoutes(app, { db: ctx.db, config: ctx.config, audit: ctx.services.audit, sessions });
  registerSourceOauthRoutes(app, { db: ctx.db, config: ctx.config, audit: ctx.services.audit, services: ctx.services });
  registerHealthRoutes(app, ctx);
  registerConversationsRoutes(app, ctx);
  registerDigestRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerPeopleProjectRoutes(app, ctx);
  registerSourcesRoutes(app, ctx);
  registerUploadsRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerPolicyRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerPreferenceRoutes(app, ctx);
  registerLlmRoutes(app, ctx);
  registerAuditRoutes(app, ctx);

  // Serve the built web UI in production (Docker sets DONNA_PUBLIC_DIR).
  const publicDir = ctx.config.env.DONNA_PUBLIC_DIR;
  if (publicDir && existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: resolve(publicDir), wildcard: false });
    // SPA fallback for client-side routes.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
