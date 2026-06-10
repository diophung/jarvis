import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../types.js';
import type { StreamEvent } from '../types.js';
import {
  createOpenAiCompatibleAdapter,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
} from './openai-compatible.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>, index = -1): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(index);
  if (!call) throw new Error('fetch was not called');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index = -1): Record<string, unknown> {
  return JSON.parse(String(lastRequest(fetchMock, index).init.body)) as Record<string, unknown>;
}

async function collect(stream: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai-compatible adapter: chat', () => {
  it('POSTs to {baseUrl}/chat/completions with auth header and maps the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'served-model',
        choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:8000/v1/', apiKey: 'k-123' });
    const result = await adapter.chat({
      model: 'my-model',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.2,
      maxTokens: 64,
    });

    expect(adapter.kind).toBe('openai_compatible');
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe('http://localhost:8000/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k-123');
    const body = bodyOf(fetchMock);
    expect(body['model']).toBe('my-model');
    expect(body['messages']).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body['temperature']).toBe(0.2);
    expect(body['max_tokens']).toBe(64);
    expect(body['response_format']).toBeUndefined();

    expect(result).toEqual({
      text: 'Hello there',
      model: 'served-model',
      inputTokens: 12,
      outputTokens: 5,
      stopReason: 'stop',
    });
  });

  it('sends response_format json_object when jsonMode is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'json please' }], jsonMode: true });

    expect(bodyOf(fetchMock)['response_format']).toEqual({ type: 'json_object' });
  });

  it('retries once WITHOUT response_format when the server 400s on jsonMode', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'response_format not supported' } }, 400))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const result = await adapter.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'json please' }],
      jsonMode: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 0)['response_format']).toEqual({ type: 'json_object' });
    expect(bodyOf(fetchMock, 1)['response_format']).toBeUndefined();
    expect(result.text).toBe('{"ok":true}');
  });

  it('does not retry a 400 when jsonMode was not requested', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'bad input' } }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    await expect(
      adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'bad_request', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [500, 'server', true],
  ])('maps HTTP %i to LlmError code %s', async (status, code, retryable) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'nope' } }, status));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    await expect(
      adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code, retryable });
  });

  it('maps fetch TypeError to a retryable connection error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    await expect(
      adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'connection', retryable: true });
  });
});

describe('openai-compatible adapter: chatStream', () => {
  const fixture = [
    'data: {"id":"c1","model":"served-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo!"},"finish_reason":"stop"}]}',
    '',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  it('parses SSE deltas incrementally and finishes with usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(fixture));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const events = await collect(
      adapter.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );

    const body = bodyOf(fetchMock);
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });

    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo!' },
      {
        type: 'done',
        result: {
          text: 'Hello!',
          model: 'served-model',
          inputTokens: 10,
          outputTokens: 2,
          stopReason: 'stop',
        },
      },
    ]);
  });

  it('tolerates servers that never report usage', async () => {
    const noUsage = [
      'data: {"choices":[{"index":0,"delta":{"content":"hey"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(noUsage)));

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const events = await collect(
      adapter.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      result: { text: 'hey', inputTokens: null, outputTokens: null, stopReason: 'stop' },
    });
  });

  it('retries the stream request without response_format on a jsonMode 400', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'response_format unsupported' }, 400))
      .mockResolvedValueOnce(sseResponse(fixture));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const events = await collect(
      adapter.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], jsonMode: true }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 0)['response_format']).toEqual({ type: 'json_object' });
    expect(bodyOf(fetchMock, 1)['response_format']).toBeUndefined();
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('openai-compatible adapter: embed', () => {
  it('POSTs to {baseUrl}/embeddings and returns vectors in input order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'embed-model',
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
        usage: { prompt_tokens: 7 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const result = await adapter.embed!({ model: 'e', input: ['a', 'b'] });

    const { url } = lastRequest(fetchMock);
    expect(url).toBe('http://x/v1/embeddings');
    expect(bodyOf(fetchMock)).toEqual({ model: 'e', input: ['a', 'b'] });
    expect(result).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      model: 'embed-model',
      inputTokens: 7,
    });
  });
});

describe('openai-compatible adapter: listModels + healthCheck', () => {
  it('lists model ids from GET {baseUrl}/models', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    await expect(adapter.listModels!()).resolves.toEqual(['model-a', 'model-b']);
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe('http://x/v1/models');
    expect(init.method).toBe('GET');
  });

  it('healthCheck ok with models on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'model-a' }] })),
    );
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.models).toEqual(['model-a']);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('healthCheck distinguishes auth failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'no' }, 401)));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.message).toContain('authentication failed');
    expect(health.message).toContain('401');
  });

  it('healthCheck distinguishes connection failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:9999/v1' });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.message).toContain('cannot connect');
    expect(health.message).toContain('http://localhost:9999/v1');
  });

  it('healthCheck reports unexpected HTTP statuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 503)));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://x/v1' });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.message).toContain('503');
  });
});

describe('openai-compatible adapter: defaults', () => {
  it('defaults to localhost Ollama-style base for openai_compatible and OpenAI cloud for openai', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await createOpenAiCompatibleAdapter({}).listModels!();
    expect(lastRequest(fetchMock).url).toBe(`${DEFAULT_OPENAI_COMPATIBLE_BASE_URL}/models`);

    const openai = createOpenAiCompatibleAdapter({}, 'openai');
    expect(openai.kind).toBe('openai');
    await openai.listModels!();
    expect(lastRequest(fetchMock).url).toBe(`${DEFAULT_OPENAI_BASE_URL}/models`);
  });

  it('exposes LlmError class behaviour', () => {
    const err = new LlmError('x', 'rate_limit', true);
    expect(err.name).toBe('LlmError');
    expect(err.code).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });
});
