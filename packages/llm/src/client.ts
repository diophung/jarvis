/**
 * LlmClient wraps a single provider adapter with cross-cutting concerns:
 *
 * - timeouts via AbortController (default from construction, per-call override)
 * - retries (up to `maxRetries`, default 2) on retryable LlmError codes with
 *   exponential backoff (base 300ms; `sleep` is injectable for tests)
 * - usage auditing: every logical call — success AND failure — emits exactly
 *   one LlmUsageEvent through `onUsage`. Message/input CONTENT never appears
 *   in usage events; only counts and sizes do.
 *
 * `chatStream` retries only while nothing has been yielded yet; once deltas
 * have been surfaced it terminates with a `{type:'error'}` event instead of
 * throwing, so UI consumers can render partial output plus the error.
 */
import type { LlmTask } from '@jarvis/core';
import { toLlmError } from './adapters/shared.js';
import { LlmError } from './types.js';
import type {
  ChatParams,
  ChatResult,
  EmbedParams,
  EmbedResult,
  LlmHealth,
  LlmProviderAdapter,
  LlmUsageEvent,
  StreamEvent,
} from './types.js';

const RETRYABLE_CODES: ReadonlySet<LlmError['code']> = new Set([
  'connection',
  'rate_limit',
  'server',
  'timeout',
]);

export const DEFAULT_BACKOFF_BASE_MS = 300;
export const DEFAULT_MAX_RETRIES = 2;

export interface LlmClientOptions {
  /** Applied when a call does not carry its own timeoutMs. */
  defaultTimeoutMs?: number;
  /** Max retry attempts after the first failure (default 2). */
  maxRetries?: number;
  /** Exponential backoff base in ms (default 300 -> 300, 600, ...). */
  backoffBaseMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Receives one usage event per logical call (success and failure). */
  onUsage?: (event: LlmUsageEvent) => void;
  /** Injectable clock (ms) used for latency measurement only. */
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TimeoutHandle {
  signal: AbortSignal | undefined;
  cleanup: () => void;
}

export class LlmClient {
  constructor(
    private readonly adapter: LlmProviderAdapter,
    private readonly options: LlmClientOptions = {},
  ) {}

  get kind() {
    return this.adapter.kind;
  }

  get supportsEmbeddings(): boolean {
    return typeof this.adapter.embed === 'function';
  }

  private get maxRetries(): number {
    return this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private get backoffBaseMs(): number {
    return this.options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  }

  private get sleep(): (ms: number) => Promise<void> {
    return this.options.sleep ?? realSleep;
  }

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private emit(event: LlmUsageEvent): void {
    this.options.onUsage?.(event);
  }

  /**
   * Build an AbortSignal that fires after timeoutMs (with an LlmError timeout
   * as the abort reason) and also follows an optional external signal.
   */
  private startTimeout(timeoutMs: number | undefined, external: AbortSignal | undefined): TimeoutHandle {
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return { signal: external, cleanup: () => {} };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new LlmError(`request timed out after ${timeoutMs}ms`, 'timeout', true));
    }, timeoutMs);
    const followExternal = () => {
      controller.abort(external?.reason ?? new LlmError('request aborted', 'timeout', true));
    };
    if (external !== undefined) {
      if (external.aborted) followExternal();
      else external.addEventListener('abort', followExternal, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', followExternal);
      },
    };
  }

  /** Settle with the signal's reason even if the adapter ignores the signal. */
  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return promise;
    if (signal.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new LlmError('request aborted', 'timeout', true),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new LlmError('request aborted', 'timeout', true),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  async chat(params: ChatParams, task: LlmTask = 'chat'): Promise<ChatResult> {
    const timeoutMs = params.timeoutMs ?? this.options.defaultTimeoutMs;
    const requestSummary = {
      messageCount: params.messages.length,
      totalChars: params.messages.reduce((n, m) => n + m.content.length, 0),
    };
    const started = this.now();
    let attempt = 0;
    for (;;) {
      const handle = this.startTimeout(timeoutMs, params.abortSignal);
      try {
        const result = await this.raceAbort(
          this.adapter.chat({ ...params, timeoutMs: undefined, abortSignal: handle.signal }),
          handle.signal,
        );
        handle.cleanup();
        this.emit({
          providerKind: this.adapter.kind,
          model: params.model,
          task,
          status: 'success',
          latencyMs: this.now() - started,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          requestSummary,
        });
        return result;
      } catch (err) {
        handle.cleanup();
        const llmErr = toLlmError(err);
        if (RETRYABLE_CODES.has(llmErr.code) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        this.emit({
          providerKind: this.adapter.kind,
          model: params.model,
          task,
          status: llmErr.code === 'timeout' ? 'timeout' : 'error',
          latencyMs: this.now() - started,
          inputTokens: null,
          outputTokens: null,
          error: llmErr.message,
          requestSummary,
        });
        throw llmErr;
      }
    }
  }

  async *chatStream(params: ChatParams, task: LlmTask = 'chat'): AsyncGenerator<StreamEvent, void, void> {
    const timeoutMs = params.timeoutMs ?? this.options.defaultTimeoutMs;
    const requestSummary = {
      messageCount: params.messages.length,
      totalChars: params.messages.reduce((n, m) => n + m.content.length, 0),
    };
    const started = this.now();
    let attempt = 0;
    let yieldedDelta = false;
    for (;;) {
      const handle = this.startTimeout(timeoutMs, params.abortSignal);
      try {
        const stream = this.adapter.chatStream({
          ...params,
          timeoutMs: undefined,
          abortSignal: handle.signal,
        });
        for (;;) {
          const next = await this.raceAbort(stream.next(), handle.signal);
          if (next.done === true) {
            throw new LlmError('stream ended without a done event', 'parse', false);
          }
          const event = next.value;
          if (event.type === 'delta') {
            yieldedDelta = true;
            yield event;
          } else if (event.type === 'done') {
            handle.cleanup();
            this.emit({
              providerKind: this.adapter.kind,
              model: params.model,
              task,
              status: 'success',
              latencyMs: this.now() - started,
              inputTokens: event.result.inputTokens,
              outputTokens: event.result.outputTokens,
              requestSummary,
            });
            yield event;
            return;
          } else {
            // Adapter surfaced a mid-stream error event.
            throw new LlmError(event.error, 'server', true);
          }
        }
      } catch (err) {
        handle.cleanup();
        const llmErr = toLlmError(err);
        if (!yieldedDelta && RETRYABLE_CODES.has(llmErr.code) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        this.emit({
          providerKind: this.adapter.kind,
          model: params.model,
          task,
          status: llmErr.code === 'timeout' ? 'timeout' : 'error',
          latencyMs: this.now() - started,
          inputTokens: null,
          outputTokens: null,
          error: llmErr.message,
          requestSummary,
        });
        yield { type: 'error', error: llmErr.message };
        return;
      }
    }
  }

  async embed(params: EmbedParams, task: LlmTask = 'embedding'): Promise<EmbedResult> {
    const timeoutMs = params.timeoutMs ?? this.options.defaultTimeoutMs;
    const requestSummary = {
      inputCount: params.input.length,
      totalChars: params.input.reduce((n, s) => n + s.length, 0),
    };
    const started = this.now();
    const embedFn = this.adapter.embed?.bind(this.adapter);
    let attempt = 0;
    for (;;) {
      const handle = this.startTimeout(timeoutMs, undefined);
      try {
        if (embedFn === undefined) {
          throw new LlmError(
            `provider "${this.adapter.kind}" does not support embeddings`,
            'unsupported',
            false,
          );
        }
        // EmbedParams carries no abortSignal, so keep timeoutMs on the params:
        // the adapter aborts its own fetch while raceAbort enforces the same
        // deadline at the client level.
        const result = await this.raceAbort(embedFn({ ...params, timeoutMs }), handle.signal);
        handle.cleanup();
        this.emit({
          providerKind: this.adapter.kind,
          model: params.model,
          task,
          status: 'success',
          latencyMs: this.now() - started,
          inputTokens: result.inputTokens,
          outputTokens: null,
          requestSummary,
        });
        return result;
      } catch (err) {
        handle.cleanup();
        const llmErr = toLlmError(err);
        if (RETRYABLE_CODES.has(llmErr.code) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        this.emit({
          providerKind: this.adapter.kind,
          model: params.model,
          task,
          status: llmErr.code === 'timeout' ? 'timeout' : 'error',
          latencyMs: this.now() - started,
          inputTokens: null,
          outputTokens: null,
          error: llmErr.message,
          requestSummary,
        });
        throw llmErr;
      }
    }
  }

  async healthCheck(model?: string): Promise<LlmHealth> {
    return this.adapter.healthCheck(model);
  }

  async listModels(): Promise<string[]> {
    if (this.adapter.listModels === undefined) return [];
    return this.adapter.listModels();
  }
}
