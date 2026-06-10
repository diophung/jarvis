import { describe, expect, it, vi } from 'vitest';
import { LlmClient } from './client.js';
import { LlmError } from './types.js';
import type {
  ChatParams,
  ChatResult,
  LlmProviderAdapter,
  LlmUsageEvent,
  StreamEvent,
} from './types.js';

const okResult: ChatResult = {
  text: 'fine',
  model: 'm',
  inputTokens: 11,
  outputTokens: 7,
  stopReason: 'stop',
};

function makeAdapter(overrides: Partial<LlmProviderAdapter> = {}): LlmProviderAdapter {
  return {
    kind: 'openai_compatible',
    chat: vi.fn().mockResolvedValue(okResult),
    // eslint-disable-next-line require-yield
    chatStream: async function* (): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'delta', text: 'fi' };
      yield { type: 'delta', text: 'ne' };
      yield { type: 'done', result: okResult };
    },
    embed: vi.fn().mockResolvedValue({ vectors: [[1, 0]], model: 'e', inputTokens: 3 }),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1, message: 'ok' }),
    ...overrides,
  };
}

function instantSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

const params: ChatParams = {
  model: 'm',
  messages: [{ role: 'user', content: 'SECRET-CONTENT do not leak this' }],
};

async function collect(stream: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('LlmClient: timeout', () => {
  it('rejects with an LlmError timeout and emits a timeout usage event', async () => {
    const events: LlmUsageEvent[] = [];
    const hangingChat = vi.fn(() => new Promise<ChatResult>(() => {}));
    const client = new LlmClient(makeAdapter({ chat: hangingChat }), {
      defaultTimeoutMs: 15,
      maxRetries: 0,
      onUsage: (e) => events.push(e),
    });

    await expect(client.chat(params)).rejects.toMatchObject({
      name: 'LlmError',
      code: 'timeout',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'timeout', inputTokens: null, outputTokens: null });
  });

  it('retries timeouts (timeout is retryable) up to maxRetries', async () => {
    const { sleep, delays } = instantSleep();
    const hangingChat = vi.fn(() => new Promise<ChatResult>(() => {}));
    const client = new LlmClient(makeAdapter({ chat: hangingChat }), {
      defaultTimeoutMs: 10,
      maxRetries: 2,
      sleep,
    });

    await expect(client.chat(params)).rejects.toMatchObject({ code: 'timeout' });
    expect(hangingChat).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([300, 600]);
  });

  it('per-call timeoutMs overrides the default', async () => {
    const seen: Array<number | undefined> = [];
    const chat = vi.fn((p: ChatParams) => {
      seen.push(p.timeoutMs);
      return Promise.resolve(okResult);
    });
    const client = new LlmClient(makeAdapter({ chat }), { defaultTimeoutMs: 60_000 });
    await client.chat({ ...params, timeoutMs: 5 });
    // the client owns the deadline: adapters receive the abort signal instead
    expect(seen).toEqual([undefined]);
    const abortSignal = chat.mock.calls[0]?.[0]?.abortSignal;
    expect(abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('LlmClient: retries', () => {
  it('retries retryable errors with exponential backoff and then succeeds', async () => {
    const { sleep, delays } = instantSleep();
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('boom', 'server', true))
      .mockRejectedValueOnce(new LlmError('slow down', 'rate_limit', true))
      .mockResolvedValueOnce(okResult);
    const events: LlmUsageEvent[] = [];
    const client = new LlmClient(makeAdapter({ chat }), { sleep, onUsage: (e) => events.push(e) });

    const result = await client.chat(params);
    expect(result).toEqual(okResult);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([300, 600]);
    // one event per logical call, success after retries
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'success', inputTokens: 11, outputTokens: 7 });
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const { sleep, delays } = instantSleep();
    const chat = vi.fn().mockRejectedValue(new LlmError('down', 'connection', true));
    const client = new LlmClient(makeAdapter({ chat }), { sleep });

    await expect(client.chat(params)).rejects.toMatchObject({ code: 'connection' });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([300, 600]);
  });

  it('does not retry non-retryable codes (bad_request, auth)', async () => {
    for (const code of ['bad_request', 'auth'] as const) {
      const { sleep } = instantSleep();
      const chat = vi.fn().mockRejectedValue(new LlmError('nope', code, false));
      const client = new LlmClient(makeAdapter({ chat }), { sleep });
      await expect(client.chat(params)).rejects.toMatchObject({ code });
      expect(chat).toHaveBeenCalledTimes(1);
    }
  });

  it('wraps non-LlmError failures (TypeError -> connection) and retries them', async () => {
    const { sleep } = instantSleep();
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResult);
    const client = new LlmClient(makeAdapter({ chat }), { sleep });
    await expect(client.chat(params)).resolves.toEqual(okResult);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});

describe('LlmClient: usage events', () => {
  it('emits a success event with counts and never includes message content', async () => {
    const events: LlmUsageEvent[] = [];
    const client = new LlmClient(makeAdapter(), { onUsage: (e) => events.push(e) });

    await client.chat(params, 'summarization');

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      providerKind: 'openai_compatible',
      model: 'm',
      task: 'summarization',
      status: 'success',
      inputTokens: 11,
      outputTokens: 7,
      requestSummary: { messageCount: 1, totalChars: params.messages[0]!.content.length },
    });
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain('SECRET-CONTENT');
  });

  it('emits an error event on failure, still without content', async () => {
    const events: LlmUsageEvent[] = [];
    const chat = vi.fn().mockRejectedValue(new LlmError('denied', 'auth', false));
    const client = new LlmClient(makeAdapter({ chat }), { onUsage: (e) => events.push(e) });

    await expect(client.chat(params)).rejects.toMatchObject({ code: 'auth' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'error',
      error: 'denied',
      inputTokens: null,
      outputTokens: null,
      requestSummary: { messageCount: 1 },
    });
    expect(JSON.stringify(events)).not.toContain('SECRET-CONTENT');
  });

  it('emits usage for embed calls with input counts only', async () => {
    const events: LlmUsageEvent[] = [];
    const client = new LlmClient(makeAdapter(), { onUsage: (e) => events.push(e) });

    await client.embed({ model: 'e', input: ['SECRET-CONTENT-A', 'b'] });

    expect(events[0]).toMatchObject({
      task: 'embedding',
      status: 'success',
      inputTokens: 3,
      requestSummary: { inputCount: 2, totalChars: 'SECRET-CONTENT-A'.length + 1 },
    });
    expect(JSON.stringify(events)).not.toContain('SECRET-CONTENT');
  });

  it('embed on a provider without embeddings throws unsupported and emits an error event', async () => {
    const events: LlmUsageEvent[] = [];
    const adapter = makeAdapter();
    delete (adapter as { embed?: unknown }).embed;
    const client = new LlmClient(adapter, { onUsage: (e) => events.push(e) });

    await expect(client.embed({ model: 'e', input: ['x'] })).rejects.toMatchObject({
      code: 'unsupported',
      retryable: false,
    });
    expect(events[0]).toMatchObject({ status: 'error' });
  });
});

describe('LlmClient: chatStream', () => {
  it('passes deltas through and emits a success usage event from the done result', async () => {
    const events: LlmUsageEvent[] = [];
    const client = new LlmClient(makeAdapter(), { onUsage: (e) => events.push(e) });

    const streamed = await collect(client.chatStream(params, 'digest'));
    expect(streamed).toEqual([
      { type: 'delta', text: 'fi' },
      { type: 'delta', text: 'ne' },
      { type: 'done', result: okResult },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      task: 'digest',
      status: 'success',
      inputTokens: 11,
      outputTokens: 7,
    });
  });

  it('retries when the stream fails before any delta was yielded', async () => {
    const { sleep, delays } = instantSleep();
    let calls = 0;
    const chatStream = function (): AsyncGenerator<StreamEvent, void, void> {
      calls += 1;
      if (calls === 1) {
        // eslint-disable-next-line require-yield
        return (async function* (): AsyncGenerator<StreamEvent, void, void> {
          throw new LlmError('connect fail', 'connection', true);
        })();
      }
      return (async function* (): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'delta', text: 'ok' };
        yield { type: 'done', result: okResult };
      })();
    };
    const client = new LlmClient(makeAdapter({ chatStream }), { sleep });

    const streamed = await collect(client.chatStream(params));
    expect(calls).toBe(2);
    expect(delays).toEqual([300]);
    expect(streamed.at(-1)?.type).toBe('done');
  });

  it('does NOT retry after deltas were yielded; terminates with an error event', async () => {
    const { sleep, delays } = instantSleep();
    const events: LlmUsageEvent[] = [];
    let calls = 0;
    const chatStream = function (): AsyncGenerator<StreamEvent, void, void> {
      calls += 1;
      return (async function* (): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'delta', text: 'partial' };
        throw new LlmError('mid-stream drop', 'server', true);
      })();
    };
    const client = new LlmClient(makeAdapter({ chatStream }), {
      sleep,
      onUsage: (e) => events.push(e),
    });

    const streamed = await collect(client.chatStream(params));
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(streamed).toEqual([
      { type: 'delta', text: 'partial' },
      { type: 'error', error: 'mid-stream drop' },
    ]);
    expect(events[0]).toMatchObject({ status: 'error', error: 'mid-stream drop' });
  });

  it('times out a stalled stream with a timeout usage event', async () => {
    const events: LlmUsageEvent[] = [];
    const chatStream = function (): AsyncGenerator<StreamEvent, void, void> {
      return (async function* (): AsyncGenerator<StreamEvent, void, void> {
        yield { type: 'delta', text: 'start' };
        await new Promise(() => {}); // stall forever
      })();
    };
    const client = new LlmClient(makeAdapter({ chatStream }), {
      defaultTimeoutMs: 15,
      maxRetries: 0,
      onUsage: (e) => events.push(e),
    });

    const streamed = await collect(client.chatStream(params));
    expect(streamed[0]).toEqual({ type: 'delta', text: 'start' });
    expect(streamed.at(-1)).toMatchObject({ type: 'error' });
    expect(events[0]).toMatchObject({ status: 'timeout' });
  });
});
