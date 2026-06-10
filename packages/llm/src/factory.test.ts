import { describe, expect, it } from 'vitest';
import { createAdapter, KIND_DEFAULTS } from './factory.js';

describe('createAdapter', () => {
  it('creates an adapter for every provider kind with the matching kind tag', () => {
    expect(createAdapter('openai').kind).toBe('openai');
    expect(createAdapter('openai_compatible').kind).toBe('openai_compatible');
    expect(createAdapter('anthropic').kind).toBe('anthropic');
    expect(createAdapter('gemini').kind).toBe('gemini');
    expect(createAdapter('mock').kind).toBe('mock');
  });

  it('only anthropic lacks embeddings support among real adapters', () => {
    expect(createAdapter('anthropic').embed).toBeUndefined();
    expect(createAdapter('openai').embed).toBeTypeOf('function');
    expect(createAdapter('openai_compatible').embed).toBeTypeOf('function');
    expect(createAdapter('gemini').embed).toBeTypeOf('function');
    expect(createAdapter('mock').embed).toBeTypeOf('function');
  });
});

describe('KIND_DEFAULTS', () => {
  it('covers every kind with sensible defaults', () => {
    expect(KIND_DEFAULTS.openai.defaultBaseUrl).toBe('https://api.openai.com/v1');
    expect(KIND_DEFAULTS.openai_compatible.defaultBaseUrl).toBe('http://localhost:11434/v1');
    expect(KIND_DEFAULTS.openai_compatible.isLocalByDefault).toBe(true);
    expect(KIND_DEFAULTS.anthropic.defaultBaseUrl).toBe('https://api.anthropic.com');
    expect(KIND_DEFAULTS.anthropic.supportsEmbeddings).toBe(false);
    expect(KIND_DEFAULTS.gemini.defaultBaseUrl).toBe('https://generativelanguage.googleapis.com');
    expect(KIND_DEFAULTS.mock.isLocalByDefault).toBe(true);
    for (const defaults of Object.values(KIND_DEFAULTS)) {
      expect(defaults.label.length).toBeGreaterThan(0);
    }
  });

  it('agrees with the adapters on embeddings support', () => {
    for (const kind of ['openai', 'openai_compatible', 'anthropic', 'gemini', 'mock'] as const) {
      expect(KIND_DEFAULTS[kind].supportsEmbeddings).toBe(
        typeof createAdapter(kind).embed === 'function',
      );
    }
  });
});
