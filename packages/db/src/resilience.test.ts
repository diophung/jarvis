import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  isTransientDbError,
  withRetry,
} from './resilience.js';

function errWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(`error ${code}`), { code });
}

describe('isTransientDbError', () => {
  it('classifies connection and contention errors as transient', () => {
    expect(isTransientDbError(errWithCode('ECONNRESET'))).toBe(true);
    expect(isTransientDbError(errWithCode('ETIMEDOUT'))).toBe(true);
    expect(isTransientDbError(errWithCode('40001'))).toBe(true); // serialization failure
    expect(isTransientDbError(errWithCode('40P01'))).toBe(true); // deadlock
    expect(isTransientDbError(errWithCode('08006'))).toBe(true); // connection failure class
    expect(isTransientDbError(errWithCode('57P03'))).toBe(true); // failover
    expect(isTransientDbError(errWithCode('SQLITE_BUSY'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('never classifies application errors as transient (no blind retries)', () => {
    expect(isTransientDbError(errWithCode('23505'))).toBe(false); // unique violation
    expect(isTransientDbError(errWithCode('42601'))).toBe(false); // syntax error
    expect(isTransientDbError(new Error('Memory entry not found'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError('nope')).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries transient errors with backoff and succeeds', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw errWithCode('ECONNRESET');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 1, onRetry },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw errWithCode('23505');
        },
        { attempts: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('23505');
    expect(calls).toBe(1);
  });

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw errWithCode('ETIMEDOUT');
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('ETIMEDOUT');
    expect(calls).toBe(3);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and fails fast', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, now: () => clock });
    const boom = async (): Promise<never> => {
      throw new Error('backend down');
    };
    await expect(breaker.exec(boom)).rejects.toThrow('backend down');
    await expect(breaker.exec(boom)).rejects.toThrow('backend down');
    expect(breaker.state).toBe('open');
    // Open breaker rejects without calling the function.
    const spy = vi.fn(boom);
    await expect(breaker.exec(spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
    // After the reset timeout it half-opens and a success closes it.
    clock = 1001;
    expect(breaker.state).toBe('half_open');
    await expect(breaker.exec(async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.state).toBe('closed');
  });

  it('a half-open failure re-opens immediately', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => clock });
    await expect(breaker.exec(async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(breaker.state).toBe('open');
    clock = 101;
    await expect(breaker.exec(async () => Promise.reject(new Error('y')))).rejects.toThrow('y');
    expect(breaker.state).toBe('open');
  });
});
