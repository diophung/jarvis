/**
 * Backfill tool: copy a local SQLite database into a production Postgres.
 *
 * Usage:
 *   pnpm --filter @jarvis/server exec tsx src/scripts/migrate-sqlite-to-postgres.ts \
 *     --sqlite ./data/jarvis.db --target postgres://user:pass@host:5432/jarvis [--dry-run] [--batch 500]
 *
 * Properties:
 *  - Dry-run mode reads + reports only; no writes are issued.
 *  - Copies in foreign-key-safe order, in batches, ordered by primary key.
 *  - Idempotent: rows that already exist in the target (same id) are skipped
 *    (INSERT ... ON CONFLICT DO NOTHING), so a crashed run can simply be
 *    re-run.
 *  - Never modifies the source database.
 *  - Prints a per-table source/target count verification at the end.
 *
 * Run target migrations first (the tool does this automatically when not in
 * dry-run). Stop API/worker processes that write to the SQLite file during
 * the copy, or re-run the tool afterwards to pick up stragglers.
 */
import { createDb, isPostgresUrl, migrateToLatest, type DB, type Db } from '@jarvis/db';
import process from 'node:process';

/** Copy order: referenced entities before referencing ones. */
const TABLES: ReadonlyArray<keyof DB> = [
  'users',
  'workspaces',
  'authAccounts',
  'sessions',
  'oauthTokens',
  'sourceAccounts',
  'sourceItems',
  'sourceAttachments',
  'people',
  'organizations',
  'projects',
  'taskCandidates',
  'digests',
  'digestItems',
  'userPreferences',
  'memoryEntries',
  'permissionPolicies',
  'agentActions',
  'approvalRequests',
  'auditLogs',
  'conversations',
  'messages',
  'uploadedFiles',
  'connectorRuns',
  'llmProviderConfigs',
  'llmTaskRoutes',
  'llmCallLogs',
  'retrievalChunks',
  'embeddingRecords',
  'itemFeedback',
  'appSettings',
  'learningSignals',
  'learnedPreferences',
  'idempotencyKeys',
  'dataDeletionRequests',
];

interface Args {
  sqlite: string;
  target: string | undefined;
  dryRun: boolean;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sqlite: './data/jarvis.db',
    target: process.env.DATABASE_URL,
    dryRun: false,
    batch: 500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sqlite') args.sqlite = argv[++i] ?? args.sqlite;
    else if (arg === '--target') args.target = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--batch') args.batch = Number(argv[++i] ?? args.batch);
  }
  return args;
}

async function countRows(db: Db, table: keyof DB): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!isPostgresUrl(args.target)) {
    console.error('A postgres:// target is required (--target or DATABASE_URL).');
    process.exit(1);
  }
  console.log(`source: sqlite ${args.sqlite}`);
  console.log(`target: ${args.target!.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(args.dryRun ? 'mode:   DRY RUN (no writes)' : `mode:   copy (batch ${args.batch})`);

  const source = createDb({ sqlitePath: args.sqlite });
  const target = createDb({ databaseUrl: args.target });

  try {
    if (!args.dryRun) {
      console.log('\napplying target migrations…');
      await migrateToLatest(target);
    }

    let totalCopied = 0;
    let totalSkipped = 0;
    const verification: Array<{ table: string; source: number; target: number }> = [];

    for (const table of TABLES) {
      const sourceCount = await countRows(source, table);
      if (args.dryRun) {
        const targetCount = await countRows(target, table).catch(() => -1);
        verification.push({ table, source: sourceCount, target: targetCount });
        console.log(
          `${table.padEnd(24)} would copy ${sourceCount} rows (target currently ${targetCount === -1 ? 'n/a' : targetCount})`,
        );
        continue;
      }

      let copied = 0;
      let skipped = 0;
      for (let offset = 0; offset < sourceCount; offset += args.batch) {
        const rows = await source
          .selectFrom(table)
          .selectAll()
          .orderBy('id')
          .limit(args.batch)
          .offset(offset)
          .execute();
        if (rows.length === 0) break;
        const result = await target
          .insertInto(table)
          .values(rows as never)
          .onConflict((oc) => oc.column('id').doNothing())
          .executeTakeFirst();
        const inserted = Number(result.numInsertedOrUpdatedRows ?? 0);
        copied += inserted;
        skipped += rows.length - inserted;
      }
      totalCopied += copied;
      totalSkipped += skipped;
      const targetCount = await countRows(target, table);
      verification.push({ table, source: sourceCount, target: targetCount });
      console.log(
        `${table.padEnd(24)} copied ${copied}, skipped ${skipped} (already present), target now ${targetCount}`,
      );
    }

    console.log('\n--- verification ---');
    let mismatches = 0;
    for (const v of verification) {
      const ok = args.dryRun || v.target >= v.source;
      if (!ok) mismatches += 1;
      console.log(`${ok ? 'OK  ' : 'MISS'} ${v.table.padEnd(24)} source=${v.source} target=${v.target}`);
    }
    if (!args.dryRun) {
      console.log(`\ncopied ${totalCopied} rows, skipped ${totalSkipped} existing.`);
      if (mismatches > 0) {
        console.error(`${mismatches} table(s) have fewer target rows than source — re-run the tool.`);
        process.exit(2);
      }
      console.log('Backfill complete. Point DATABASE_URL at the target and restart Jarvis.');
    }
  } finally {
    await source.destroy();
    await target.destroy();
  }
}

await main();
