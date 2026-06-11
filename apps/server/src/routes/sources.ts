/**
 * Sources & sync routes (see docs/api-contract.md "Sources & sync").
 */
import {
  fromJson,
  newId,
  nowIso,
  toJson,
  GOOGLE_SOURCE_TYPES,
  SOURCE_CATEGORIES,
  type SourceAccount,
} from '@donna/core';
import type { SourceAccountsTable } from '@donna/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';
import {
  mapConnectorRunRow,
  mapSourceAccountRow,
  mapSourceItemRow,
} from '../services/ingestion.js';

/** Per-account auth fields added in v1.1 (docs/api-contract.md). */
export interface SourceAccountView extends SourceAccount {
  authKind: 'oauth' | 'env' | 'local';
  grantedScopes: string[];
}

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

  /** Decorate an account row with authKind / grantedScopes for the API. */
  function toAccountView(row: SourceAccountsTable, grantedScopes?: string[]): SourceAccountView {
    const account = mapSourceAccountRow(row);
    const isOauth = services.tokens.isOauthAccount(row.authRef);
    const descriptor = connectors.get(row.provider)?.descriptor;
    const authKind: SourceAccountView['authKind'] = isOauth
      ? 'oauth'
      : descriptor && !descriptor.local
        ? 'env'
        : 'local';
    return { ...account, authKind, grantedScopes: isOauth ? (grantedScopes ?? []) : [] };
  }

  /** grantedScopes per oauth-backed account in the workspace. */
  async function scopesByAccountId(workspaceId: string): Promise<Map<string, string[]>> {
    const rows = await db
      .selectFrom('oauthTokens')
      .select(['sourceAccountId', 'grantedScopes'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (row.sourceAccountId) map.set(row.sourceAccountId, fromJson<string[]>(row.grantedScopes, []));
    }
    return map;
  }

  // -- Catalog ---------------------------------------------------------------

  app.get('/api/sources/catalog', async () => {
    // The Google sources are connectable through per-source OAuth whenever a
    // Google OAuth client is configured — no GOOGLE_REFRESH_TOKEN env needed.
    const googleOauthConfigured =
      !!services.secrets.env('GOOGLE_CLIENT_ID') && !!services.secrets.env('GOOGLE_CLIENT_SECRET');
    const items = connectors.list().map((connector) => {
      const descriptor = connector.descriptor;
      const oauthConnectable = (GOOGLE_SOURCE_TYPES as readonly string[]).includes(
        descriptor.provider,
      );
      const configured =
        descriptor.local ||
        descriptor.requiredEnv.every((env) => !!services.secrets.env(env)) ||
        (oauthConnectable && googleOauthConfigured);
      return { ...descriptor, configured, oauthConnectable };
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
    const scopes = await scopesByAccountId(request.workspaceId);
    return { items: rows.map((row) => toAccountView(row, scopes.get(row.id))) };
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
    return { account: toAccountView(row) };
  });

  app.delete('/api/sources/accounts/:id', async (request) => {
    const { id } = request.params as { id: string };
    const account = await db
      .selectFrom('sourceAccounts')
      .select(['id', 'provider', 'displayName', 'authRef'])
      .where('id', '=', id)
      .where('workspaceId', '=', request.workspaceId)
      .executeTakeFirst();
    if (!account) throw notFound('Source account not found');

    if (services.tokens.isOauthAccount(account.authRef)) {
      // Best-effort revocation at Google; disconnect proceeds regardless.
      try {
        await services.tokens.disconnectSource(account.id);
      } catch {
        // Revocation/refresh-state failures must never block disconnect.
      }
      // Disconnect removes the stored tokens entirely.
      await db.deleteFrom('oauthTokens').where('sourceAccountId', '=', account.id).execute();
    }

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
