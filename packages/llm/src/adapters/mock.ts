/**
 * Demo-mode adapter: fully deterministic, no network, no wall clock.
 *
 * - chat: canned, clearly-labelled "demo mode" reply that echoes a compact
 *   digest-flavored answer derived from the last user message.
 * - chatStream: the same text, yielded word-by-word.
 * - embed: deterministic pseudo-vectors (seeded by a string hash, 64 dims,
 *   L2-normalized) so semantic search is demoable offline.
 * - healthCheck: always ok.
 */
import type {
  AdapterInit,
  ChatParams,
  ChatResult,
  EmbedParams,
  EmbedResult,
  LlmHealth,
  LlmProviderAdapter,
  StreamEvent,
} from '../types.js';

export const MOCK_EMBEDDING_DIMS = 64;

/** FNV-1a 32-bit string hash — stable across runs and platforms. */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 PRNG — small, fast, deterministic for a given seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pseudoVector(input: string): number[] {
  const rand = mulberry32(hashString(input));
  const vector: number[] = [];
  for (let i = 0; i < MOCK_EMBEDDING_DIMS; i += 1) {
    vector.push(rand() * 2 - 1);
  }
  let normSq = 0;
  for (const v of vector) normSq += v * v;
  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    const fallback = new Array<number>(MOCK_EMBEDDING_DIMS).fill(0);
    fallback[0] = 1;
    return fallback;
  }
  return vector.map((v) => v / norm);
}

/** Collapse whitespace and truncate so the echo stays compact. */
function compactSnippet(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars).trimEnd()}…`;
}

function approxTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

function buildDemoReply(params: ChatParams): string {
  if (params.jsonMode === true) return '{}';
  const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
  const snippet = compactSnippet(lastUser?.content ?? '', 140);
  const topic = compactSnippet(lastUser?.content ?? 'your request', 60);
  const lines = [
    '[demo mode] Donna is running without a configured LLM provider, so this is a deterministic canned reply.',
    '',
    snippet.length > 0
      ? `Quick digest of your message — "${snippet}":`
      : 'Quick digest of your message:',
    `- Key topic: ${topic}`,
    '- Suggested next step: review the related items in your queue and confirm what needs action first.',
    '- To get real answers, configure a local or cloud model under Settings → AI Providers.',
  ];
  return lines.join('\n');
}

function buildChatResult(params: ChatParams): ChatResult {
  const text = buildDemoReply(params);
  const inputChars = params.messages.reduce((n, m) => n + m.content.length, 0);
  return {
    text,
    model: params.model,
    inputTokens: approxTokens(inputChars),
    outputTokens: approxTokens(text.length),
    stopReason: 'end_turn',
  };
}

export function createMockAdapter(_init: AdapterInit = {}): LlmProviderAdapter {
  return {
    kind: 'mock',

    async chat(params: ChatParams): Promise<ChatResult> {
      return buildChatResult(params);
    },

    async *chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, void> {
      const result = buildChatResult(params);
      const words = result.text.split(' ');
      for (let i = 0; i < words.length; i += 1) {
        const piece = i < words.length - 1 ? `${words[i] ?? ''} ` : (words[i] ?? '');
        if (piece.length > 0) yield { type: 'delta', text: piece };
      }
      yield { type: 'done', result };
    },

    async embed(params: EmbedParams): Promise<EmbedResult> {
      return {
        vectors: params.input.map((text) => pseudoVector(text)),
        model: params.model,
        inputTokens: approxTokens(params.input.reduce((n, s) => n + s.length, 0)),
      };
    },

    async healthCheck(): Promise<LlmHealth> {
      return {
        ok: true,
        latencyMs: 0,
        message: 'demo mode — mock provider is always available (no network, no API key)',
        models: [],
      };
    },
  };
}
