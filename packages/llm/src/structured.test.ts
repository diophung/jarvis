import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from './client.js';
import { extractJsonObject, generateStructured } from './structured.js';
import type { ChatParams, ChatResult, LlmProviderAdapter, StreamEvent } from './types.js';

const schema = z.object({ title: z.string(), score: z.number() });

function queuedClient(responses: string[]): { client: LlmClient; calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  let i = 0;
  const adapter: LlmProviderAdapter = {
    kind: 'mock',
    chat: async (p: ChatParams): Promise<ChatResult> => {
      calls.push(p);
      const text = responses[Math.min(i, responses.length - 1)] ?? '';
      i += 1;
      return { text, model: 'm', inputTokens: 1, outputTokens: 1, stopReason: 'stop' };
    },
    chatStream: async function* (): AsyncGenerator<StreamEvent, void, void> {
      yield { type: 'done', result: { text: '', model: 'm', inputTokens: null, outputTokens: null, stopReason: null } };
    },
    healthCheck: async () => ({ ok: true, latencyMs: 0, message: 'ok' }),
  };
  return { client: new LlmClient(adapter), calls };
}

const baseParams: ChatParams = {
  model: 'm',
  messages: [{ role: 'user', content: 'extract the thing' }],
};

const opts = {
  schema,
  schemaName: 'ItemSummary',
  schemaDescription: 'An object with a string "title" and a numeric "score" between 0 and 1.',
};

describe('extractJsonObject', () => {
  it('extracts from ```json fences with surrounding prose', () => {
    const text = 'Sure! Here it is:\n```json\n{"a": 1}\n```\nHope that helps.';
    expect(extractJsonObject(text)).toBe('{"a": 1}');
  });

  it('extracts from bare ``` fences', () => {
    expect(extractJsonObject('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('extracts the first object from leading prose without fences', () => {
    expect(extractJsonObject('The answer is {"a": {"b": 2}} as requested')).toBe('{"a": {"b": 2}}');
  });

  it('is not confused by braces inside JSON strings', () => {
    expect(extractJsonObject('{"text": "uses } and { inside"} trailing')).toBe(
      '{"text": "uses } and { inside"}',
    );
  });

  it('returns null when there is no JSON object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

describe('generateStructured', () => {
  it('parses fenced JSON with leading prose on the first attempt', async () => {
    const { client, calls } = queuedClient([
      'Here you go:\n```json\n{"title": "Budget review", "score": 0.9}\n```',
    ]);

    const result = await generateStructured(client, baseParams, opts);

    expect(result.value).toEqual({ title: 'Budget review', score: 0.9 });
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    // jsonMode is forced on
    expect(calls[0]!.jsonMode).toBe(true);
    // system instruction demands ONLY JSON and names the schema
    const system = calls[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('ItemSummary');
    expect(system.content).toContain('ONLY');
    expect(system.content).toContain(opts.schemaDescription);
  });

  it('retries once with the validation error appended, then succeeds', async () => {
    const { client, calls } = queuedClient([
      '{"title": "Missing score"}',
      '{"title": "Fixed", "score": 0.5}',
    ]);

    const result = await generateStructured(client, baseParams, opts);

    expect(result.value).toEqual({ title: 'Fixed', score: 0.5 });
    expect(calls).toHaveLength(2);
    const retryMessages = calls[1]!.messages;
    const lastUser = retryMessages.at(-1)!;
    expect(lastUser.role).toBe('user');
    expect(lastUser.content).toContain('invalid');
    expect(lastUser.content).toContain('score');
    // the failed raw response is echoed back as the assistant turn
    expect(retryMessages.at(-2)).toEqual({ role: 'assistant', content: '{"title": "Missing score"}' });
  });

  it('returns the fallback (never throws) when both attempts fail validation', async () => {
    const fallback = { title: 'fallback', score: 0 };
    const { client, calls } = queuedClient(['not json at all', 'still not json']);

    const result = await generateStructured(client, baseParams, { ...opts, fallback });

    expect(calls).toHaveLength(2);
    expect(result.value).toEqual(fallback);
    expect(result.raw).toBe('still not json');
    expect(result.error).toBeDefined();
  });

  it('returns null value when both attempts fail and no fallback is given', async () => {
    const { client } = queuedClient(['{"title": 42, "score": "high"}']);
    const result = await generateStructured(client, baseParams, opts);
    expect(result.value).toBeNull();
    expect(result.error).toContain('title');
  });

  it('handles unparseable JSON bodies without throwing', async () => {
    const { client } = queuedClient(['{"title": "broken', '{"title": "broken']);
    const result = await generateStructured(client, baseParams, opts);
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });
});
