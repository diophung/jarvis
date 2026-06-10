import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/system', async () => {
    const url = ctx.config.env.DATABASE_URL;
    const dbDialect =
      url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))
        ? 'postgres'
        : 'sqlite';
    return {
      version: '0.1.0',
      dbDialect,
      storageDriver: ctx.config.env.DONNA_STORAGE_DRIVER,
      authMode: ctx.config.env.DONNA_AUTH_MODE,
      demoSeed: ctx.config.env.DONNA_DEMO_SEED,
      dataDir: ctx.config.env.DONNA_DATA_DIR,
    };
  });
}
