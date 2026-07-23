/**
 * Health, readiness, and observability endpoints.
 *
 *  - GET /api/health        liveness: process is up (no dependencies touched)
 *  - GET /api/health/ready  readiness: database round-trip with its own
 *                           deadline; 503 while the DB is unreachable so load
 *                           balancers stop routing here
 *  - GET /api/health/metrics  PII-free operational counters: query latency
 *                           percentiles, error/slow/retry counts, per-
 *                           operation stats, pool usage, cache hit/miss,
 *                           vector backend, deletion-job status
 */
import { checkDbHealth } from '@jarvis/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/health/ready', async (_request, reply) => {
    const db = await checkDbHealth(ctx.db);
    if (!db.ok) {
      return reply.code(503).send({ ok: false, db });
    }
    return { ok: true, db };
  });

  app.get('/api/health/metrics', async () => {
    const [db, pendingDeletions] = await Promise.all([
      checkDbHealth(ctx.db),
      ctx.db
        .selectFrom('dataDeletionRequests')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', 'in', ['pending', 'running'])
        .executeTakeFirst(),
    ]);
    return {
      db: {
        dialect: db.dialect,
        ok: db.ok,
        pool: db.pool,
        queries: ctx.dbMetrics?.snapshot() ?? null,
      },
      cache: ctx.services.cache.stats(),
      vectorStore: ctx.services.vectors.kind,
      deletionJobs: { open: Number(pendingDeletions?.n ?? 0) },
    };
  });

  app.get('/api/system', async () => {
    const db = await checkDbHealth(ctx.db);
    return {
      version: '0.1.0',
      dbDialect: db.dialect,
      dbOk: db.ok,
      vectorStore: ctx.services.vectors.kind,
      cacheBackend: ctx.services.cache.stats().backend,
      storageDriver: ctx.config.env.JARVIS_STORAGE_DRIVER,
      authMode: ctx.config.env.JARVIS_AUTH_MODE,
      demoSeed: ctx.config.env.JARVIS_DEMO_SEED,
      dataDir: ctx.config.env.JARVIS_DATA_DIR,
    };
  });
}
