/**
 * Provider factory: build an adapter from a provider kind plus init config,
 * and expose per-kind defaults used by the Settings UI and env bootstrap.
 */
import type { LlmProviderKind } from '@donna/core';
import {
  createAnthropicAdapter,
  DEFAULT_ANTHROPIC_BASE_URL,
} from './adapters/anthropic.js';
import { createGeminiAdapter, DEFAULT_GEMINI_BASE_URL } from './adapters/gemini.js';
import { createMockAdapter } from './adapters/mock.js';
import {
  createOpenAiCompatibleAdapter,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
} from './adapters/openai-compatible.js';
import type { AdapterInit, LlmProviderAdapter } from './types.js';

export interface KindDefaults {
  defaultBaseUrl: string;
  supportsEmbeddings: boolean;
  isLocalByDefault: boolean;
  label: string;
}

export const KIND_DEFAULTS: Record<LlmProviderKind, KindDefaults> = {
  openai: {
    defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
    supportsEmbeddings: true,
    isLocalByDefault: false,
    label: 'OpenAI',
  },
  openai_compatible: {
    defaultBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    supportsEmbeddings: true,
    isLocalByDefault: true,
    label: 'OpenAI-compatible (vLLM / Ollama / SGLang / LM Studio)',
  },
  anthropic: {
    defaultBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    supportsEmbeddings: false,
    isLocalByDefault: false,
    label: 'Anthropic',
  },
  gemini: {
    defaultBaseUrl: DEFAULT_GEMINI_BASE_URL,
    supportsEmbeddings: true,
    isLocalByDefault: false,
    label: 'Google Gemini',
  },
  mock: {
    defaultBaseUrl: '',
    supportsEmbeddings: true,
    isLocalByDefault: true,
    label: 'Demo mode (mock, offline)',
  },
};

export function createAdapter(kind: LlmProviderKind, init: AdapterInit = {}): LlmProviderAdapter {
  switch (kind) {
    case 'openai':
      return createOpenAiCompatibleAdapter(init, 'openai');
    case 'openai_compatible':
      return createOpenAiCompatibleAdapter(init, 'openai_compatible');
    case 'anthropic':
      return createAnthropicAdapter(init);
    case 'gemini':
      return createGeminiAdapter(init);
    case 'mock':
      return createMockAdapter(init);
  }
}
