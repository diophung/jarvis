import { describe, expect, it } from 'vitest';
import type { ChatParams, StreamEvent } from '../types.js';
import { createMockAdapter, MOCK_EMBEDDING_DIMS } from './mock.js';

const baseParams: ChatParams = {
  model: 'mock-model',
  messages: [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'What should I prioritize today across email and calendar?' },
  ],
};

async function collect(stream: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('mock adapter: chat', () => {
  it('is deterministic for identical inputs', async () => {
    const adapter = createMockAdapter();
    const a = await adapter.chat(baseParams);
    const b = await adapter.chat(baseParams);
    expect(a).toEqual(b);
  });

  it('clearly notes demo mode and echoes a digest of the last user message', async () => {
    const adapter = createMockAdapter();
    const result = await adapter.chat(baseParams);
    expect(result.text.toLowerCase()).toContain('demo mode');
    expect(result.text).toContain('What should I prioritize today');
    expect(result.stopReason).toBe('end_turn');
    expect(result.model).toBe('mock-model');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  it('returns {} in jsonMode so structured generation degrades cleanly', async () => {
    const adapter = createMockAdapter();
    const result = await adapter.chat({ ...baseParams, jsonMode: true });
    expect(result.text).toBe('{}');
  });
});

describe('mock adapter: chatStream', () => {
  it('streams the same text word-by-word and reassembles exactly', async () => {
    const adapter = createMockAdapter();
    const chatResult = await adapter.chat(baseParams);
    const events = await collect(adapter.chatStream(baseParams));

    const deltas = events.filter((e): e is Extract<StreamEvent, { type: 'delta' }> => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected terminal done event');
    expect(deltas.map((d) => d.text).join('')).toBe(chatResult.text);
    expect(done.result.text).toBe(chatResult.text);
  });
});

describe('mock adapter: embed', () => {
  it('returns 64-dim, L2-normalized, deterministic vectors', async () => {
    const adapter = createMockAdapter();
    const first = await adapter.embed!({ model: 'mock-embed', input: ['quarterly report', 'lunch plans'] });
    const second = await adapter.embed!({ model: 'mock-embed', input: ['quarterly report', 'lunch plans'] });

    expect(first.vectors).toHaveLength(2);
    for (const vector of first.vectors) {
      expect(vector).toHaveLength(MOCK_EMBEDDING_DIMS);
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
    // deterministic across calls
    expect(first.vectors).toEqual(second.vectors);
    // different inputs produce different directions
    expect(first.vectors[0]).not.toEqual(first.vectors[1]);
  });

  it('embeds the same string identically regardless of batch position', async () => {
    const adapter = createMockAdapter();
    const a = await adapter.embed!({ model: 'mock-embed', input: ['hello'] });
    const b = await adapter.embed!({ model: 'mock-embed', input: ['other', 'hello'] });
    expect(a.vectors[0]).toEqual(b.vectors[1]);
  });
});

describe('mock adapter: healthCheck', () => {
  it('is always ok without any network access', async () => {
    const adapter = createMockAdapter();
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.message.toLowerCase()).toContain('demo');
  });
});
