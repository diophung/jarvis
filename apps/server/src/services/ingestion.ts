/**
 * Ingestion service: runs connector syncs for source accounts.
 *
 * Pipeline per account: load connector -> page through connector.sync ->
 * normalize each raw item -> upsert by (accountId, externalId) with
 * content-hash change detection -> basic cross-source dedupe by dedupeKey ->
 * insert attachments -> upsert observed people -> index new/changed items ->
 * record the ConnectorRun + audit entry and persist the new cursor.
 */
import {
  consoleConnectorLogger,
  type ConnectorContext,
  type ConnectorRegistry,
} from '@donna/connectors';
import {
  fromJson,
  newId,
  normalizeRawItem,
  nowIso,
  toJson,
  type ConnectorCapability,
  type ConnectorRun,
  type NormalizedItemInput,
  type PersonRef,
  type SourceAccount,
  type SourceCategory,
  type SourceItem,
} from '@donna/core';
import type {
  ConnectorRunsTable,
  Db,
  SourceAccountsTable,
  SourceItemsTable,
} from '@donna/db';
import {
  SETTING_KEYS,
  type AuditService,
  type IndexingService,
  type IngestionService,
  type SecretsService,
  type SettingsService,
  type TokensService,
} from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

/** Hard cap on pages per run so a buggy connector can never loop forever. */
const MAX_PAGES = 50;

const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

// ---------- Row -> entity mappers (shared with routes/sources.ts) ----------

export function mapConnectorRunRow(row: ConnectorRunsTable): ConnectorRun {
  return {
    ...row,
    mode: row.mode as ConnectorRun['mode'],
    status: row.status as ConnectorRun['status'],
    errors: fromJson<string[]>(row.errors, []),
    triggeredBy: row.triggeredBy as ConnectorRun['triggeredBy'],
  };
}

export function mapSourceAccountRow(row: SourceAccountsTable): SourceAccount {
  return {
    ...row,
    category: row.category as SourceCategory,
    status: row.status as SourceAccount['status'],
    scopes: fromJson<string[]>(row.scopes, []),
    capabilities: fromJson<ConnectorCapability[]>(row.capabilities, []),
    settings: fromJson<Record<string, unknown>>(row.settings, {}),
  };
}

export function mapSourceItemRow(row: SourceItemsTable): SourceItem {
  return {
    ...row,
    category: row.category as SourceCategory,
    sender: fromJson<PersonRef | null>(row.sender, null),
    participants: fromJson<PersonRef[]>(row.participants, []),
    projectIds: fromJson<string[]>(row.projectIds, []),
    peopleIds: fromJson<string[]>(row.peopleIds, []),
    labels: fromJson<string[]>(row.labels, []),
    rawMetadata: fromJson<Record<string, unknown>>(row.rawMetadata, {}),
    provenance: fromJson<SourceItem['provenance']>(row.provenance, {}),
  };
}

// ---------- Service ----------

interface PersonCacheEntry {
  id: string;
  interactionCount: number;
  lastInteractionAt: string | null;
}

export function createIngestionService(deps: {
  db: Db;
  connectors: ConnectorRegistry;
  secrets: SecretsService;
  audit: AuditService;
  settings: SettingsService;
  indexing: IndexingService;
  /**
   * Per-source OAuth token service. Optional only so pre-v1.1 fixtures keep
   * working — production wiring MUST pass it or OAuth-connected accounts
   * cannot sync.
   */
  tokens?: TokensService;
}): IngestionService {
  const { db, connectors, secrets, audit, settings, indexing, tokens } = deps;

  /** Load workspace people once per run into an email -> person cache. */
  async function loadPeopleByEmail(workspaceId: string): Promise<Map<string, PersonCacheEntry>> {
    const rows = await db
      .selectFrom('people')
      .select(['id', 'emails', 'interactionCount', 'lastInteractionAt'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    const byEmail = new Map<string, PersonCacheEntry>();
    for (const row of rows) {
      const entry: PersonCacheEntry = {
        id: row.id,
        interactionCount: row.interactionCount,
        lastInteractionAt: row.lastInteractionAt,
      };
      for (const email of fromJson<string[]>(row.emails, [])) {
        byEmail.set(email.toLowerCase(), entry);
      }
    }
    return byEmail;
  }

  /**
   * Upsert an observed person by email. The sender gets interactionCount+1
   * and lastInteractionAt; participants are only created if unknown. An
   * existing person's importance is never touched (so it is never downgraded).
   */
  async function upsertPerson(
    workspaceId: string,
    cache: Map<string, PersonCacheEntry>,
    ref: PersonRef | null,
    isSender: boolean,
    itemTimestamp: string,
  ): Promise<void> {
    const email = ref?.email?.toLowerCase();
    if (!email) return;
    const now = nowIso();
    const existing = cache.get(email);
    if (!existing) {
      const entry: PersonCacheEntry = {
        id: newId('per'),
        interactionCount: isSender ? 1 : 0,
        lastInteractionAt: isSender ? itemTimestamp : null,
      };
      await db
        .insertInto('people')
        .values({
          id: entry.id,
          workspaceId,
          displayName: ref?.name ?? email,
          emails: toJson([email]),
          handles: toJson(ref?.handle ? [ref.handle] : []),
          organizationId: null,
          title: null,
          importance: 'normal',
          isSelf: 0,
          interactionCount: entry.interactionCount,
          lastInteractionAt: entry.lastInteractionAt,
          notes: null,
          origin: 'observed',
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      cache.set(email, entry);
      return;
    }
    if (!isSender) return;
    existing.interactionCount += 1;
    if (existing.lastInteractionAt === null || itemTimestamp > existing.lastInteractionAt) {
      existing.lastInteractionAt = itemTimestamp;
    }
    await db
      .updateTable('people')
      .set({
        interactionCount: existing.interactionCount,
        lastInteractionAt: existing.lastInteractionAt,
        updatedAt: now,
      })
      .where('id', '=', existing.id)
      .execute();
  }

  async function indexItem(
    workspaceId: string,
    account: SourceAccount,
    itemId: string,
    normalized: NormalizedItemInput,
  ): Promise<void> {
    await indexing.indexText(
      workspaceId,
      'source_item',
      itemId,
      `${normalized.title}\n${normalized.bodyText ?? ''}`,
      {
        title: normalized.title,
        sourceLabel: account.displayName,
        category: normalized.category,
        url: normalized.url ?? undefined,
      },
    );
  }

  async function syncAccount(
    workspaceId: string,
    accountId: string,
    opts: { mode: 'full' | 'incremental'; triggeredBy: 'manual' | 'scheduled' | 'connect' },
  ): Promise<ConnectorRun> {
    const accountRow = await db
      .selectFrom('sourceAccounts')
      .selectAll()
      .where('id', '=', accountId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!accountRow) throw notFound('Source account not found');
    const account = mapSourceAccountRow(accountRow);

    const connector = connectors.get(account.provider);
    if (!connector) throw badRequest(`Unknown connector provider '${account.provider}'`);

    const ctx: ConnectorContext = {
      accountId,
      workspaceId,
      settings: account.settings,
      secrets: secrets.connectorResolver(),
      logger: consoleConnectorLogger,
      // OAuth-connected accounts get a server-managed token source; env-based
      // accounts keep resolving credentials through ctx.secrets.
      oauth:
        tokens && tokens.isOauthAccount(account.authRef)
          ? tokens.tokenSourceFor(accountId)
          : undefined,
    };

    const runId = newId('run');
    const startedAt = nowIso();
    await db
      .insertInto('connectorRuns')
      .values({
        id: runId,
        workspaceId,
        accountId,
        mode: opts.mode,
        status: 'running',
        startedAt,
        completedAt: null,
        itemsSeen: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        errorCount: 0,
        errors: toJson([]),
        cursorBefore: account.syncCursor,
        cursorAfter: null,
        log: null,
        triggeredBy: opts.triggeredBy,
        createdAt: startedAt,
      })
      .execute();

    const counts = { seen: 0, created: 0, updated: 0 };
    const errors: string[] = [];
    const logLines: string[] = [];
    const peopleCache = await loadPeopleByEmail(workspaceId);
    let cursor: string | null = opts.mode === 'incremental' ? account.syncCursor : null;
    let cursorAfter: string | null = null;
    let pagesSucceeded = 0;

    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      let done = true;
      try {
        const page = await connector.sync(ctx, { mode: opts.mode, cursor });
        for (const raw of page.items) {
          counts.seen += 1;
          const normalized = normalizeRawItem(raw);
          const now = nowIso();

          const existing = await db
            .selectFrom('sourceItems')
            .select(['id', 'contentHash', 'isRead', 'labels'])
            .where('accountId', '=', accountId)
            .where('externalId', '=', normalized.externalId)
            .executeTakeFirst();

          if (existing) {
            if (existing.contentHash === normalized.contentHash) {
              // Content unchanged; still persist cheap metadata flips
              // (read state, labels) so they never go stale.
              const labelsJson = toJson(normalized.labels);
              if (existing.isRead === normalized.isRead && existing.labels === labelsJson) {
                continue; // unchanged
              }
              await db
                .updateTable('sourceItems')
                .set({ isRead: normalized.isRead, labels: labelsJson, updatedAt: now })
                .where('id', '=', existing.id)
                .execute();
              counts.updated += 1;
              continue;
            }
            await db
              .updateTable('sourceItems')
              .set({
                title: normalized.title,
                bodyText: normalized.bodyText,
                snippet: normalized.snippet,
                sender: normalized.sender ? toJson(normalized.sender) : null,
                participants: toJson(normalized.participants),
                itemTimestamp: normalized.itemTimestamp,
                dueAt: normalized.dueAt,
                startsAt: normalized.startsAt,
                endsAt: normalized.endsAt,
                url: normalized.url,
                labels: toJson(normalized.labels),
                isRead: normalized.isRead,
                rawMetadata: toJson(normalized.rawMetadata),
                contentHash: normalized.contentHash,
                updatedAt: now,
              })
              .where('id', '=', existing.id)
              .execute();
            counts.updated += 1;
            await indexItem(workspaceId, account, existing.id, normalized);
            continue;
          }

          // Basic cross-source dedupe: the same meeting/file can arrive via
          // multiple accounts; skip when another account already has the key.
          // Same-account items are excluded: the fallback dedupeKey
          // (title+day+sender) would otherwise drop legitimate distinct items,
          // and (accountId, externalId) already catches true duplicates.
          const dupe = await db
            .selectFrom('sourceItems')
            .select(['id'])
            .where('workspaceId', '=', workspaceId)
            .where('accountId', '!=', accountId)
            .where('dedupeKey', '=', normalized.dedupeKey)
            .executeTakeFirst();
          if (dupe) {
            logLines.push(
              `Skipped duplicate item externalId=${normalized.externalId} (dedupeKey=${normalized.dedupeKey} matches existing ${dupe.id})`,
            );
            continue;
          }

          const itemId = newId('itm');
          await db
            .insertInto('sourceItems')
            .values({
              id: itemId,
              workspaceId,
              accountId,
              provider: account.provider,
              category: normalized.category,
              externalId: normalized.externalId,
              dedupeKey: normalized.dedupeKey,
              title: normalized.title,
              bodyText: normalized.bodyText,
              snippet: normalized.snippet,
              sender: normalized.sender ? toJson(normalized.sender) : null,
              participants: toJson(normalized.participants),
              itemTimestamp: normalized.itemTimestamp,
              dueAt: normalized.dueAt,
              startsAt: normalized.startsAt,
              endsAt: normalized.endsAt,
              url: normalized.url,
              threadExternalId: normalized.threadExternalId,
              projectIds: toJson([]),
              peopleIds: toJson([]),
              labels: toJson(normalized.labels),
              rawMetadata: toJson(normalized.rawMetadata),
              provenance: toJson({ connectorRunId: runId }),
              isRead: normalized.isRead,
              contentHash: normalized.contentHash,
              createdAt: now,
              updatedAt: now,
            })
            .execute();
          counts.created += 1;

          for (const att of normalized.attachments) {
            await db
              .insertInto('sourceAttachments')
              .values({
                id: newId('att'),
                itemId,
                workspaceId,
                filename: att.filename,
                mimeType: att.mimeType ?? null,
                sizeBytes: att.sizeBytes ?? null,
                externalRef: att.externalRef ?? null,
                storagePath: null,
                textExtracted: 0,
                createdAt: now,
              })
              .execute();
          }

          await upsertPerson(
            workspaceId,
            peopleCache,
            normalized.sender,
            true,
            normalized.itemTimestamp,
          );
          for (const participant of normalized.participants) {
            await upsertPerson(
              workspaceId,
              peopleCache,
              participant,
              false,
              normalized.itemTimestamp,
            );
          }

          await indexItem(workspaceId, account, itemId, normalized);
        }
        cursor = page.nextCursor;
        cursorAfter = page.nextCursor;
        done = page.done;
        pagesSucceeded += 1;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        break; // retrying the same cursor would loop; surface as partial/error
      }
      if (done) break;
    }

    const status: ConnectorRun['status'] =
      errors.length === 0 ? 'success' : pagesSucceeded > 0 ? 'partial' : 'error';
    const completedAt = nowIso();

    await db
      .updateTable('connectorRuns')
      .set({
        status,
        completedAt,
        itemsSeen: counts.seen,
        itemsCreated: counts.created,
        itemsUpdated: counts.updated,
        errorCount: errors.length,
        errors: toJson(errors),
        cursorAfter,
        log: logLines.length > 0 ? logLines.join('\n') : null,
      })
      .where('id', '=', runId)
      .execute();

    await db
      .updateTable('sourceAccounts')
      .set({
        lastSyncAt: completedAt,
        syncCursor: cursorAfter ?? account.syncCursor,
        status: status === 'error' ? 'error' : 'connected',
        updatedAt: completedAt,
      })
      .where('id', '=', accountId)
      .execute();

    await audit.log({
      workspaceId,
      eventType: 'connector.sync',
      actor: opts.triggeredBy === 'scheduled' ? 'worker' : 'user',
      targetType: 'source_account',
      targetId: accountId,
      summary: `Synced ${account.displayName} (${account.provider}): ${counts.created} created, ${counts.updated} updated, ${counts.seen} seen`,
      metadata: {
        mode: opts.mode,
        triggeredBy: opts.triggeredBy,
        status,
        itemsSeen: counts.seen,
        itemsCreated: counts.created,
        itemsUpdated: counts.updated,
        errorCount: errors.length,
      },
    });

    const row = await db
      .selectFrom('connectorRuns')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    return mapConnectorRunRow(row);
  }

  async function syncDueAccounts(opts: { triggeredBy: 'scheduled' }): Promise<number> {
    const accounts = await db
      .selectFrom('sourceAccounts')
      .select(['id', 'workspaceId', 'lastSyncAt', 'provider'])
      .where('status', '=', 'connected')
      .execute();

    const intervalByWorkspace = new Map<string, number>();
    const now = Date.now();
    let synced = 0;

    for (const account of accounts) {
      let intervalMinutes = intervalByWorkspace.get(account.workspaceId);
      if (intervalMinutes === undefined) {
        intervalMinutes = await settings.get<number>(
          account.workspaceId,
          SETTING_KEYS.syncIntervalMinutes,
          DEFAULT_SYNC_INTERVAL_MINUTES,
        );
        intervalByWorkspace.set(account.workspaceId, intervalMinutes);
      }

      let due = true;
      if (account.lastSyncAt !== null) {
        const last = Date.parse(account.lastSyncAt);
        due = Number.isNaN(last) || now - last >= intervalMinutes * 60_000;
      }
      if (!due) continue;

      try {
        await syncAccount(account.workspaceId, account.id, {
          mode: 'incremental',
          triggeredBy: opts.triggeredBy,
        });
        synced += 1;
      } catch (err) {
        // One broken account must never stop the others.
        console.error(
          `[ingestion] scheduled sync failed for account ${account.id} (${account.provider}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return synced;
  }

  return { syncAccount, syncDueAccounts };
}
