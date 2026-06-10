/**
 * Internal helpers shared by the fetch-based provider adapters: URL joining,
 * HTTP error -> LlmError mapping, abort-signal composition, and SSE parsing.
 */
import { LlmError } from '../types.js';

/** Join a base URL and a path without producing double slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** Map an HTTP status code to an LlmError per the provider-layer contract. */
export function httpStatusToLlmError(status: number, detail: string): LlmError {
  const message = detail.length > 0 ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
  if (status === 401 || status === 403) return new LlmError(message, 'auth', false);
  if (status === 408) return new LlmError(message, 'timeout', true);
  if (status === 429) return new LlmError(message, 'rate_limit', true);
  if (status >= 500) return new LlmError(message, 'server', true);
  if (status >= 400) return new LlmError(message, 'bad_request', false);
  return new LlmError(message, 'server', true);
}

/**
 * Normalize an arbitrary thrown value into an LlmError. fetch network failures
 * surface as TypeError -> connection; aborts/timeouts -> timeout.
 */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return new LlmError(err.message.length > 0 ? err.message : 'request aborted', 'timeout', true);
    }
    if (err instanceof TypeError) {
      // undici wraps the useful detail in `cause` (e.g. ECONNREFUSED).
      const cause = (err as { cause?: unknown }).cause;
      const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
      return new LlmError(`connection failed: ${err.message}${causeMsg}`, 'connection', true);
    }
    return new LlmError(err.message, 'server', true);
  }
  return new LlmError(String(err), 'server', true);
}

/**
 * Extract a short, human-useful error detail from an HTTP error response.
 * Truncated so provider error bodies never bloat logs.
 */
export async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        const record = parsed as { error?: { message?: unknown } | string; message?: unknown };
        const fromError =
          typeof record.error === 'string'
            ? record.error
            : typeof record.error?.message === 'string'
              ? record.error.message
              : undefined;
        const msg = fromError ?? (typeof record.message === 'string' ? record.message : undefined);
        if (typeof msg === 'string' && msg.length > 0) return msg.slice(0, 500);
      }
    } catch {
      // Not JSON — fall through to raw text.
    }
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Combine an optional per-call timeout with an optional external abort signal.
 * Returns undefined when neither applies.
 */
export function combineSignals(
  timeoutMs: number | undefined,
  external: AbortSignal | undefined,
): AbortSignal | undefined {
  const timeoutSignal =
    timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (external !== undefined && timeoutSignal !== undefined) {
    return AbortSignal.any([external, timeoutSignal]);
  }
  return external ?? timeoutSignal;
}

/**
 * Incrementally parse a Server-Sent-Events response body, yielding the payload
 * of each `data:` line (other SSE fields such as `event:` are skipped — the
 * payloads we consume are self-describing JSON).
 */
export async function* sseData(res: Response): AsyncGenerator<string, void, void> {
  if (res.body === null) {
    throw new LlmError('streaming response has no body', 'parse', false);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  const emitLine = (rawLine: string): string | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return null;
    return line.slice('data:'.length).trimStart();
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const payload = emitLine(buffer.slice(0, newlineIdx));
      buffer = buffer.slice(newlineIdx + 1);
      if (payload !== null) yield payload;
      newlineIdx = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  const payload = emitLine(buffer.trim());
  if (payload !== null && payload.length > 0) yield payload;
}

/** Perform a fetch, mapping network failures and HTTP errors to LlmError. */
export async function fetchOrThrow(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw toLlmError(err);
  }
  return res;
}

/** fetch + status check + JSON parse, all mapped to LlmError. */
export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchOrThrow(url, init);
  if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new LlmError(`provider returned invalid JSON from ${url}`, 'parse', false);
  }
}
