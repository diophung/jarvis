/**
 * Mixed-workload database benchmark.
 *
 * Simulates Jarvis's hottest access patterns against the configured database
 * (DATABASE_URL or a throwaway SQLite file):
 *   - preference reads (personalization lookup)        ~50%
 *   - recent memory reads (assistant context)          ~20%
 *   - feedback event writes                            ~15%
 *   - learning signal writes                           ~15%
 *
 * Usage:
 *   pnpm --filter @jarvis/server exec tsx src/scripts/bench-db.ts [--seconds 10] [--concurrency 8]
 *
 * Honesty note: a laptop benchmark does NOT certify 20K TPS. It exists to
 * catch obvious inefficiencies (missing indexes, N+1s, slow hot paths) and
 * to compare adapters. The 20K TPS scale assumptions live in
 * docs/production-database.md.
 */
import { newId, nowIso, toJson } from '@jarvis/core';
import { createDb, createDbMetrics, getDbRuntime, migrateToLatest } from '@jarvis/db';
import { rmSync } from 'node:fs';
import process from 'node:process';
import { createAuditService } from '../services/audit.js';
import { createLearningService } from '../services/learning.js';
import { createMemoryCache } from '../services/cache.js';
import { createMemoryService } from '../services/memory.js';
import { createSettingsService } from '../services/settings.js';

interface Args {
  seconds: number;
  concurrency: number;
  cache: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seconds: 10, concurrency: 8, cache: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seconds') args.seconds = Number(argv[++i] ?? 10);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i] ?? 8);
    else if (argv[i] === '--no-cache') args.cache = false;
  }
  return args;
}

class Histogram {
  private readonly values: number[] = [];
  observe(ms: number): void {
    this.values.push(ms);
  }
  get count(): number {
    return this.values.length;
  }
  percentile(p: number): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round((sorted[Math.max(0, idx)] ?? 0) * 100) / 100;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tempSqlite = `./data/bench-${Date.now()}.db`;
  const usingUrl = process.env.DATABASE_URL;
  const metrics = createDbMetrics({ slowQueryMs: 100 });
  const db = createDb({
    ...(usingUrl !== undefined ? { databaseUrl: usingUrl } : { sqlitePath: tempSqlite }),
    metrics,
    pool: { size: Math.max(10, args.concurrency) },
    applicationName: 'jarvis-bench',
  });
  await migrateToLatest(db);
  console.log(`dialect: ${getDbRuntime(db).dialect}, concurrency ${args.concurrency}, ${args.seconds}s, cache ${args.cache ? 'on' : 'off'}`);

  // ---- seed one workspace with realistic volume
  const now = nowIso();
  const userId = newId('usr');
  const workspaceId = newId('wsp');
  await db
    .insertInto('users')
    .values({ id: userId, email: `bench-${userId}@example.com`, name: 'Bench', passwordHash: null, role: 'owner', emailVerified: 0, createdAt: now, updatedAt: now })
    .execute();
  await db
    .insertInto('workspaces')
    .values({ id: workspaceId, ownerUserId: userId, name: 'Bench', createdAt: now, updatedAt: now })
    .execute();

  const audit = createAuditService({ db });
  const cache = args.cache ? createMemoryCache() : undefined;
  const settings = createSettingsService({ db, ...(cache !== undefined ? { cache } : {}) });
  const learning = createLearningService({ db, settings, audit, ...(cache !== undefined ? { cache } : {}) });
  const memory = createMemoryService({ db, settings, audit });

  for (let i = 0; i < 50; i += 1) {
    await learning.createExplicit(workspaceId, userId, {
      statement: `bench preference ${i}: prioritize topic-${i}`,
      category: 'topics',
    });
    await memory.create(workspaceId, userId, {
      kind: 'fact',
      content: `bench memory ${i}: project alpha-${i} review meeting deadline budget`,
      origin: 'explicit',
    });
  }
  // Source items so feedback writes resolve a real row.
  const itemIds: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const id = newId('itm');
    itemIds.push(id);
    await db
      .insertInto('sourceItems')
      .values({
        id, workspaceId, accountId: 'acc_bench', provider: 'gmail', category: 'email',
        externalId: id, dedupeKey: null, title: `Bench email ${i} budget alpha`,
        bodyText: 'bench body', snippet: null, sender: toJson({ email: `p${i % 20}@bench.io` }),
        participants: '[]', itemTimestamp: now, dueAt: null, startsAt: null, endsAt: null,
        url: null, threadExternalId: null, projectIds: '[]', peopleIds: '[]', labels: '[]',
        rawMetadata: '{}', provenance: '{}', isRead: 0, contentHash: null, createdAt: now, updatedAt: now,
      })
      .execute();
  }

  // ---- mixed workload
  const ops = {
    preference_read: new Histogram(),
    memory_read: new Histogram(),
    feedback_write: new Histogram(),
    signal_write: new Histogram(),
  };
  type OpName = keyof typeof ops;
  const pickOp = (): OpName => {
    const r = Math.random();
    if (r < 0.5) return 'preference_read';
    if (r < 0.7) return 'memory_read';
    if (r < 0.85) return 'feedback_write';
    return 'signal_write';
  };

  let errors = 0;
  const deadline = Date.now() + args.seconds * 1000;
  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      const op = pickOp();
      const started = performance.now();
      try {
        if (op === 'preference_read') {
          await learning.getPreferencesByContext(workspaceId, userId, {});
        } else if (op === 'memory_read') {
          await memory.relevant(workspaceId, 'project review deadline budget', 5);
        } else if (op === 'feedback_write') {
          await db
            .insertInto('itemFeedback')
            .values({
              id: newId('fbk'), workspaceId, userId,
              sourceItemId: itemIds[Math.floor(Math.random() * itemIds.length)] ?? null,
              taskCandidateId: null, digestItemId: null, kind: 'important', note: null, createdAt: nowIso(),
            })
            .execute();
        } else {
          await learning.recordSignals(workspaceId, userId, [
            {
              kind: 'feedback',
              key: `topic.priority:bench${Math.floor(Math.random() * 1e9)}`,
              value: 'high',
              strength: 0.5,
              scope: {},
              detail: 'bench signal',
              source: { sourceType: 'item_feedback', observedAt: nowIso() },
              observedAt: nowIso(),
            },
          ]);
        }
      } catch {
        errors += 1;
      }
      ops[op].observe(performance.now() - started);
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const elapsedSec = (Date.now() - startedAt) / 1000;

  // ---- report
  let total = 0;
  console.log('\nop                count   ops/s    p50ms   p95ms   p99ms');
  for (const [name, hist] of Object.entries(ops)) {
    total += hist.count;
    console.log(
      `${name.padEnd(16)} ${String(hist.count).padStart(6)} ${(hist.count / elapsedSec).toFixed(0).padStart(7)} ${String(hist.percentile(50)).padStart(8)} ${String(hist.percentile(95)).padStart(7)} ${String(hist.percentile(99)).padStart(7)}`,
    );
  }
  console.log(`\ntotal ${total} ops in ${elapsedSec.toFixed(1)}s = ${(total / elapsedSec).toFixed(0)} ops/s, ${errors} errors`);
  const snap = metrics.snapshot();
  console.log(`db: ${snap.totalQueries} queries, p95 ${snap.latencyMs.p95}ms, p99 ${snap.latencyMs.p99}ms, ${snap.slowQueries} slow, ${snap.totalErrors} errors`);
  if (cache !== undefined) {
    const c = cache.stats();
    console.log(`cache: ${c.hits} hits / ${c.misses} misses (${((c.hits / Math.max(1, c.hits + c.misses)) * 100).toFixed(1)}% hit rate)`);
  }

  await db.destroy();
  if (usingUrl === undefined) rmSync(tempSqlite, { force: true });
  rmSync(`${tempSqlite}-wal`, { force: true });
  rmSync(`${tempSqlite}-shm`, { force: true });
}

await main();
