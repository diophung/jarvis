import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../types.js';
import { createGeminiAdapter, DEFAULT_GEMINI_BASE_URL } from './gemini.js';

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

describe('gemini adapter: chat', () => {
  it('maps system->systemInstruction and assistant->model, key in header NOT URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Bonjour' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 4 },
        modelVersion: 'served-model',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createGeminiAdapter({ apiKey: 'g-key-secret' });
    const result = await adapter.chat({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'Answer in French.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'salut' },
        { role: 'user', content: 'again' },
      ],
      temperature: 0.4,
      maxTokens: 100,
    });

    expect(adapter.kind).toBe('gemini');
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe(`${DEFAULT_GEMINI_BASE_URL}/v1beta/models/test-model:generateContent`);
    // NEVER put the key in the URL.
    expect(url).not.toContain('g-key-secret');
    expect(url).not.toContain('key=');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key-secret');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['systemInstruction']).toEqual({ parts: [{ text: 'Answer in French.' }] });
    expect(body['contents']).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'salut' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
    expect(body['generationConfig']).toEqual({ temperature: 0.4, maxOutputTokens: 100 });

    expect(result).toEqual({
      text: 'Bonjour',
      model: 'served-model',
      inputTokens: 21,
      outputTokens: 4,
      stopReason: 'STOP',
    });
  });

  it('jsonMode sets generationConfig.responseMimeType application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createGeminiAdapter({ apiKey: 'k' });
    await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'json' }], jsonMode: true });

    const body = JSON.parse(String(lastRequest(fetchMock).init.body)) as {
      generationConfig?: Record<string, unknown>;
    };
    expect(body.generationConfig?.['responseMimeType']).toBe('application/json');
  });

  it('accepts models already prefixed with models/', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ candidates: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createGeminiAdapter({ apiKey: 'k' });
    await adapter.chat({ model: 'models/test-model', messages: [{ role: 'user', content: 'x' }] });
    expect(lastRequest(fetchMock).url).toBe(
      `${DEFAULT_GEMINI_BASE_URL}/v1beta/models/test-model:generateContent`,
    );
  });

  it('maps HTTP 429 to rate_limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'quota' } }, 429)),
    );
    const adapter = createGeminiAdapter({ apiKey: 'k' });
    await expect(
      adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'rate_limit', retryable: true });
  });
});

describe('gemini adapter: chatStream', () => {
  it('streams via :streamGenerateContent?alt=sse and accumulates usage', async () => {
    const fixture = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Bon"}]}}],"modelVersion":"served-model"}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"jour"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":3}}',
      '',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(new Response(fixture, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createGeminiAdapter({ apiKey: 'secret-key' });
    const events = await collect(
      adapter.chatStream({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
    );

    const { url } = lastRequest(fetchMock);
    expect(url).toBe(
      `${DEFAULT_GEMINI_BASE_URL}/v1beta/models/test-model:streamGenerateContent?alt=sse`,
    );
    expect(url).not.toContain('secret-key');

    expect(events).toEqual([
      { type: 'delta', text: 'Bon' },
      { type: 'delta', text: 'jour' },
      {
        type: 'done',
        result: {
          text: 'Bonjour',
          model: 'served-model',
          inputTokens: 9,
          outputTokens: 3,
          stopReason: 'STOP',
        },
      },
    ]);
  });
});

describe('gemini adapter: embed + listModels + healthCheck', () => {
  it('embeds via batchEmbedContents with per-request model paths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createGeminiAdapter({ apiKey: 'k' });
    const result = await adapter.embed!({ model: 'embed-model', input: ['one', 'two'] });

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe(`${DEFAULT_GEMINI_BASE_URL}/v1beta/models/embed-model:batchEmbedContents`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['requests']).toEqual([
      { model: 'models/embed-model', content: { parts: [{ text: 'one' }] } },
      { model: 'models/embed-model', content: { parts: [{ text: 'two' }] } },
    ]);
    expect(result.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(result.model).toBe('embed-model');
  });

  it('lists models from GET /v1beta/models stripping the models/ prefix', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ models: [{ name: 'models/model-a' }, { name: 'models/model-b' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createGeminiAdapter({ apiKey: 'k' });
    await expect(adapter.listModels!()).resolves.toEqual(['model-a', 'model-b']);
    expect(lastRequest(fetchMock).url).toBe(`${DEFAULT_GEMINI_BASE_URL}/v1beta/models`);
  });

  it('healthCheck reports auth failures usefully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'API key not valid' } }, 403)),
    );
    const adapter = createGeminiAdapter({ apiKey: 'bad' });
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.message).toContain('authentication failed');
  });
});
