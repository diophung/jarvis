/**
 * LLM provider abstraction. Adapters are pure fetch-based clients — no vendor
 * SDKs. One adapter covers every OpenAI-compatible endpoint (OpenAI, vLLM,
 * Ollama, SGLang, LM Studio, llama.cpp, OpenRouter, ...).
 */
import type { LlmProviderKind, LlmTask } from '@jarvis/core';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Ask the provider for JSON output where supported (best-effort). */
  jsonMode?: boolean;
  stopSequences?: string[];
  abortSignal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; result: ChatResult }
  | { type: 'error'; error: string };

export interface EmbedParams {
  model: string;
  input: string[];
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  inputTokens: number | null;
}

export interface LlmHealth {
  ok: boolean;
  latencyMs: number;
  message: string;
  models?: string[];
}

export interface LlmProviderAdapter {
  readonly kind: LlmProviderKind;
  chat(params: ChatParams): Promise<ChatResult>;
  chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, void>;
  /** Optional: not all providers support embeddings (e.g. Anthropic). */
  embed?(params: EmbedParams): Promise<EmbedResult>;
  /** Optional: model capability discovery where the API supports it. */
  listModels?(): Promise<string[]>;
  /** Cheap reachability + auth check, ideally without burning tokens. */
  healthCheck(model?: string): Promise<LlmHealth>;
}

export interface AdapterInit {
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  defaultTimeoutMs?: number;
}

export type AdapterFactory = (init: AdapterInit) => LlmProviderAdapter;

/** Usage record emitted after every call for audit logging. */
export interface LlmUsageEvent {
  providerKind: LlmProviderKind;
  model: string;
  task: LlmTask;
  status: 'success' | 'error' | 'timeout';
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error?: string;
  requestSummary: { messageCount?: number; totalChars?: number; inputCount?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'timeout'
      | 'auth'
      | 'rate_limit'
      | 'connection'
      | 'bad_request'
      | 'server'
      | 'parse'
      | 'unsupported',
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
