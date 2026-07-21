/**
 * Resilience primitives for database and cache access: transient-error
 * classification, retry with exponential backoff + jitter, and a small
 * circuit breaker.
 *
 * Retry discipline: ONLY safe operations may be retried — reads, and writes
 * that are idempotent by construction (upsert-by-id, INSERT ... ON CONFLICT
 * DO NOTHING, or requests guarded by an idempotency key). Callers opt in
 * explicitly; nothing retries by default.
 */

/** Postgres SQLSTATE classes / codes that indicate a transient condition. */
const PG_TRANSIENT_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57P03', // cannot_connect_now (e.g. during failover)
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);
const PG_TRANSIENT_CLASS_PREFIXES = ['08']; // connection_exception family

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * True for errors worth retrying: connection failures, failover blips,
 * deadlocks/serialization conflicts, SQLite busy contention. Constraint
 * violations, syntax errors, and application errors are NOT retryable.
 */
export function isTransientDbError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (NETWORK_ERROR_CODES.has(code)) return true;
  if (PG_TRANSIENT_CODES.has(code)) return true;
  if (PG_TRANSIENT_CLASS_PREFIXES.some((p) => code.startsWith(p))) return true;
  // better-sqlite3 surfaces lock contention as SQLITE_BUSY codes.
  if (code.startsWith('SQLITE_BUSY')) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /connection terminated|connection closed|timeout exceeded when trying to connect/i.test(
    message,
  );
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Default: isTransientDbError. */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Run `fn` with exponential backoff + full jitter on retryable errors.
 * Use only for reads and idempotent writes (see module doc).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const isRetryable = options.isRetryable ?? isTransientDbError;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      options.onRetry?.(err, attempt);
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.random() * cap; // full jitter
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before probing. Default 30s. */
  resetTimeoutMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  onStateChange?: (state: CircuitState) => void;
}

export class CircuitOpenError extends Error {
  constructor() {
    super('circuit breaker is open');
    this.name = 'CircuitOpenError';
  }
}

/**
 * Fail-fast guard for optional dependencies (Redis cache, vector search).
 * When open, calls are rejected immediately with CircuitOpenError so the
 * caller can take its degraded path without waiting on a dead backend.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;
  private readonly onStateChange: ((state: CircuitState) => void) | undefined;
  private failures = 0;
  private openedAt = 0;
  private currentState: CircuitState = 'closed';

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  get state(): CircuitState {
    if (this.currentState === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) {
      return 'half_open';
    }
    return this.currentState;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open') throw new CircuitOpenError();
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private setState(state: CircuitState): void {
    if (this.currentState !== state) {
      this.currentState = state;
      this.onStateChange?.(state);
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.setState('closed');
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold || this.state === 'half_open') {
      this.openedAt = this.now();
      this.setState('open');
    }
  }
}
