/**
 * Dependency-free database metrics. createDb() feeds every query through
 * DbMetrics via Kysely's log hook; the server exposes snapshots on the
 * health/metrics endpoints and emits structured slow-query logs.
 *
 * PII safety: only SQL *text* (parameterized by Kysely — placeholders, never
 * values) and durations are recorded. Parameters are never captured.
 */

const HISTOGRAM_CAPACITY = 4096;
const SQL_SNIPPET_LENGTH = 300;

/** Ring buffer percentile estimator over the most recent N observations. */
class LatencyRing {
  private readonly values = new Float64Array(HISTOGRAM_CAPACITY);
  private size = 0;
  private next = 0;

  observe(ms: number): void {
    this.values[this.next] = ms;
    this.next = (this.next + 1) % HISTOGRAM_CAPACITY;
    if (this.size < HISTOGRAM_CAPACITY) this.size += 1;
  }

  percentile(p: number): number {
    if (this.size === 0) return 0;
    const sorted = [...this.values.subarray(0, this.size)].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return round2(sorted[idx] ?? 0);
  }

  max(): number {
    if (this.size === 0) return 0;
    let m = 0;
    for (let i = 0; i < this.size; i += 1) m = Math.max(m, this.values[i] ?? 0);
    return round2(m);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface OperationStats {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export interface SlowQueryEvent {
  /** Parameterized SQL, truncated — never contains parameter values. */
  sql: string;
  durationMs: number;
  operation: string;
}

export interface DbMetricsSnapshot {
  totalQueries: number;
  totalErrors: number;
  slowQueries: number;
  retries: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  /** Per `operation table` bucket (e.g. "select source_items"). */
  byOperation: Record<string, { count: number; errors: number; avgMs: number; maxMs: number }>;
}

/** Classify a SQL statement into a low-cardinality "operation table" bucket. */
export function classifyQuery(sql: string): string {
  const head = sql.trimStart().slice(0, 120).toLowerCase();
  const op = head.split(/[\s(]/, 1)[0] ?? 'other';
  const tableMatch = /(?:from|into|update|table)\s+"?([a-z0-9_]+)"?/.exec(head);
  return tableMatch?.[1] !== undefined ? `${op} ${tableMatch[1]}` : op;
}

export interface DbMetrics {
  observeQuery(sql: string, durationMs: number, failed: boolean): void;
  observeRetry(): void;
  snapshot(): DbMetricsSnapshot;
  reset(): void;
}

export interface DbMetricsOptions {
  /** Queries at/above this duration count as slow and trigger onSlowQuery. Default 250ms. */
  slowQueryMs?: number;
  /** Structured slow-query sink (the server wires this to its logger). */
  onSlowQuery?: (event: SlowQueryEvent) => void;
}

export function createDbMetrics(options: DbMetricsOptions = {}): DbMetrics {
  const slowQueryMs = options.slowQueryMs ?? 250;
  const ring = new LatencyRing();
  const byOperation = new Map<string, OperationStats>();
  let totalQueries = 0;
  let totalErrors = 0;
  let slowQueries = 0;
  let retries = 0;

  return {
    observeQuery(sql, durationMs, failed) {
      totalQueries += 1;
      if (failed) totalErrors += 1;
      ring.observe(durationMs);

      const operation = classifyQuery(sql);
      const stats = byOperation.get(operation) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
      stats.count += 1;
      if (failed) stats.errors += 1;
      stats.totalMs += durationMs;
      stats.maxMs = Math.max(stats.maxMs, durationMs);
      byOperation.set(operation, stats);

      if (durationMs >= slowQueryMs) {
        slowQueries += 1;
        options.onSlowQuery?.({
          sql: sql.slice(0, SQL_SNIPPET_LENGTH),
          durationMs: round2(durationMs),
          operation,
        });
      }
    },

    observeRetry() {
      retries += 1;
    },

    snapshot() {
      const ops: DbMetricsSnapshot['byOperation'] = {};
      for (const [operation, stats] of byOperation) {
        ops[operation] = {
          count: stats.count,
          errors: stats.errors,
          avgMs: stats.count === 0 ? 0 : round2(stats.totalMs / stats.count),
          maxMs: round2(stats.maxMs),
        };
      }
      return {
        totalQueries,
        totalErrors,
        slowQueries,
        retries,
        latencyMs: {
          p50: ring.percentile(50),
          p95: ring.percentile(95),
          p99: ring.percentile(99),
          max: ring.max(),
        },
        byOperation: ops,
      };
    },

    reset() {
      totalQueries = 0;
      totalErrors = 0;
      slowQueries = 0;
      retries = 0;
      byOperation.clear();
    },
  };
}
