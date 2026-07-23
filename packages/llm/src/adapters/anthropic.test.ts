import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../types.js';
import { ANTHROPIC_VERSION, createAnthropicAdapter, DEFAULT_ANTHROPIC_BASE_URL } from './anthropic.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return { url: String(call[0]), init: (call[1] ?? {}) as RequestInit };
}

async function collect(stream: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anthropic adapter: chat', () => {
  it('POSTs /v1/messages with x-api-key + anthropic-version and lifts system messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'served-model',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' world' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 8 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAnthropicAdapter({ apiKey: 'sk-ant-test' });
    const result = await adapter.chat({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are Jarvis.' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ],
      maxTokens: 256,
      temperature: 0.1,
      stopSequences: ['END'],
    });

    expect(adapter.kind).toBe('anthropic');
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe(`${DEFAULT_ANTHROPIC_BASE_URL}/v1/messages`);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['system']).toBe('You are Jarvis.');
    expect(body['messages']).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
    expect(body['max_tokens']).toBe(256);
    expect(body['temperature']).toBe(0.1);
    expect(body['stop_sequences']).toEqual(['END']);
    expect(body['stream']).toBeUndefined();

    expect(result).toEqual({
      text: 'Hello world',
      model: 'served-model',
      inputTokens: 30,
      outputTokens: 8,
      stopReason: 'end_turn',
    });
  });

  it('always sends max_tokens (API requirement) and appends a JSON instruction in jsonMode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ content: [{ type: 'text', text: '{}' }], usage: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAnthropicAdapter({ apiKey: 'k' });
    await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], jsonMode: true });

    const body = JSON.parse(String(lastRequest(fetchMock).init.body)) as Record<string, unknown>;
    expect(typeof body['max_tokens']).toBe('number');
    expect(String(body['system'])).toMatch(/JSON/);
  });

  it('maps HTTP 401 to an auth LlmError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
      ),
    );
    const adapter = createAnthropicAdapter({ apiKey: 'bad' });
    await expect(
      adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'auth', retryable: false });
  });

  it('does not implement embed', () => {
    const adapter = createAnthropicAdapter({ apiKey: 'k' });
    expect(adapter.embed).toBeUndefined();
  });
});

describe('anthropic adapter: chatStream', () => {
  // Realistic Messages API SSE transcript.
  const fixture = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_013Zva2CMHLNnXjNJJKqJ2EF","type":"message","role":"assistant","model":"served-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: ping',
    'data: {"type":"ping"}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" friend"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  it('parses message_start/content_block_delta/message_delta into deltas + done', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(fixture, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAnthropicAdapter({ apiKey: 'k' });
    const events = await collect(
      adapter.chatStream({ model: 'requested-model', messages: [{ role: 'user', content: 'hi' }] }),
    );

    const body = JSON.parse(String(lastRequest(fetchMock).init.body)) as Record<string, unknown>;
    expect(body['stream']).toBe(true);

    expect(events).toEqual([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' friend' },
      {
        type: 'done',
        result: {
          text: 'Hello friend',
          model: 'served-model',
          inputTokens: 25,
          outputTokens: 12,
          stopReason: 'end_turn',
        },
      },
    ]);
  });

  it('maps in-stream error events to LlmError', async () => {
    const errorFixture = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3}}}',
      '',
      'event: error',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(errorFixture, { status: 200 })),
    );

    const adapter = createAnthropicAdapter({ apiKey: 'k' });
    await expect(
      collect(adapter.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toMatchObject({ message: 'Overloaded', code: 'server', retryable: true });
  });
});

describe('anthropic adapter: listModels + healthCheck', () => {
  it('lists models from GET /v1/models with auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ id: 'model-x' }, { id: 'model-y' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAnthropicAdapter({ apiKey: 'k', baseUrl: 'https://proxy.example' });
    await expect(adapter.listModels!()).resolves.toEqual(['model-x', 'model-y']);

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe('https://proxy.example/v1/models');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
  });

  it('healthCheck is ok on 200 and reports auth failures distinctly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'model-x' }] }))
      .mockResolvedValueOnce(jsonResponse({ type: 'error', error: { message: 'bad key' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAnthropicAdapter({ apiKey: 'k' });
    const healthy = await adapter.healthCheck();
    expect(healthy.ok).toBe(true);
    expect(healthy.models).toEqual(['model-x']);

    const unhealthy = await adapter.healthCheck();
    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.message).toContain('authentication failed');
  });
});
