/**
 * Sources & sync routes (see docs/api-contract.md "Sources & sync").
 */
import { newId, nowIso, toJson, SOURCE_CATEGORIES } from '@donna/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';
import {
  mapConnectorRunRow,
  mapSourceAccountRow,
  mapSourceItemRow,
} from '../services/ingestion.js';

const ConnectBodySchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1).max(120).optional(),
});

const SyncBodySchema = z.object({
  mode: z.enum(['incremental', 'full']).optional(),
});

const ItemsQuerySchema = z.object({
  category: z.enum(SOURCE_CATEGORIES).optional(),
  accountId: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.string().optional(),
});

export function registerSourcesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, connectors, services } = ctx;

  // -- Catalog ---------------------------------------------------------------

  app.get('/api/sources/catalog', async () => {
    const items = connectors.list().map((connector) => {
      const descriptor = connector.descriptor;
      const configured =
        descriptor.local || descriptor.requiredEnv.every((env) => !!services.secrets.env(env));
      return { ...descriptor, configured };
    });
    return { items };
  });

  // -- Accounts --------------------------------------------------------------

  app.get('/api/sources/accounts', async (request) => {
    const rows = await db
      .selectFrom('sourceAccounts')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
    return { items: rows.map(mapSourceAccountRow) };
  });

  app.post('/api/sources/accounts', async (request) => {
    const body = ConnectBodySchema.safeParse(request.body ?? {});
    if (!body.success) throw badRequest('provider is required');

    const connector = connectors.get(body.data.provider);
    if (!connector) throw badRequest(`Unknown provider '${body.data.provider}'`);
    const descriptor = connector.descriptor;

    const envConfigured = descriptor.requiredEnv.every((env) => !!services.secrets.env(env));
    const status = descriptor.local || envConfigured ? 'connected' : 'needs_auth';
    const displayName = body.data.displayName ?? descriptor.label;
    const id = newId('acc');
    const now = nowIso();

    await db
      .insertInto('sourceAccounts')
      .values({
        id,
        workspaceId: request.workspaceId,
        userId: request.userId,
        provider: descriptor.provider,
        category: descriptor.category,
        displayName,
        status,
        authRef: descriptor.requiredEnv[0] ?? null,
        scopes: toJson(descriptor.scopes),
        capabilities: toJson(descriptor.capabilities),
        settings: toJson({}),
        lastSyncAt: null,
        syncCursor: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    await services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'connector.connected',
      actor: 'user',
      targetType: 'source_account',
      targetId: id,
      summary: `Connected ${displayName} (${descriptor.provider})`,
      metadata: { provider: descriptor.provider, status },
    });

    const row = await db
      .selectFrom('sourceAccounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { account: mapSourceAccountRow(row) };
  });

  app.delete('/api/sources/accounts/:id', async (request) => {
    const { id } = request.params as { id: string };
    const account = await db
      .selectFrom('sourceAccounts')
      .select(['id', 'provider', 'displayName'])
      .where('id', '=', id)
      .where('workspaceId', '=', request.workspaceId)
      .executeTakeFirst();
    if (!account) throw notFound('Source account not found');

    await db.deleteFrom('sourceAccounts').where('id', '=', id).execute();

    await services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'connector.disconnected',
      actor: 'user',
      targetType: 'source_account',
      targetId: id,
      summary: `Disconnected ${account.displayName} (${account.provider})`,
      metadata: { provider: account.provider },
    });
    return { ok: true };
  });

  // -- Sync ------------------------------------------------------------------

  app.post('/api/sources/accounts/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    const body = SyncBodySchema.safeParse(request.body ?? {});
    if (!body.success) throw badRequest("mode must be 'incremental' or 'full'");
    const run = await services.ingestion.syncAccount(request.workspaceId, id, {
      mode: body.data.mode ?? 'incremental',
      triggeredBy: 'manual',
    });
    return { run };
  });

  app.get('/api/sources/accounts/:id/runs', async (request) => {
    const { id } = request.params as { id: string };
    const account = await db
      .selectFrom('sourceAccounts')
      .select(['id'])
      .where('id', '=', id)
      .where('workspaceId', '=', request.workspaceId)
      .executeTakeFirst();
    if (!account) throw notFound('Source account not found');

    const rows = await db
      .selectFrom('connectorRuns')
      .selectAll()
      .where('accountId', '=', id)
      .orderBy('startedAt', 'desc')
      .limit(20)
      .execute();
    return { items: rows.map(mapConnectorRunRow) };
  });

  // -- Items -----------------------------------------------------------------

  app.get('/api/sources/items', async (request) => {
    const query = ItemsQuerySchema.safeParse(request.query ?? {});
    if (!query.success) throw badRequest('Invalid items query');
    const { category, accountId, q, limit, before } = query.data;

    let qb = db
      .selectFrom('sourceItems')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('itemTimestamp', 'desc')
      .limit(limit ?? 50);
    if (category) qb = qb.where('category', '=', category);
    if (accountId) qb = qb.where('accountId', '=', accountId);
    if (before) qb = qb.where('itemTimestamp', '<', before);
    if (q) {
      const pattern = `%${q}%`;
      qb = qb.where((eb) =>
        eb.or([eb('title', 'like', pattern), eb('snippet', 'like', pattern)]),
      );
    }

    const rows = await qb.execute();
    return { items: rows.map(mapSourceItemRow) };
  });

  app.get('/api/sources/items/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = await db
      .selectFrom('sourceItems')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', request.workspaceId)
      .executeTakeFirst();
    if (!row) throw notFound('Source item not found');

    const attachments = await db
      .selectFrom('sourceAttachments')
      .selectAll()
      .where('itemId', '=', id)
      .orderBy('createdAt', 'asc')
      .execute();

    // Audited with the item id only — never the content.
    await services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'source.access',
      actor: 'user',
      targetType: 'source_item',
      targetId: id,
      summary: 'Source item accessed',
    });

    return { item: mapSourceItemRow(row), attachments };
  });
}
