/**
 * Fetch-based adapter for the Google Gemini API (generativelanguage).
 *
 * - The API key travels in the `x-goog-api-key` header — NEVER in the URL.
 * - Message mapping: system -> systemInstruction, assistant -> role "model".
 * - jsonMode -> generationConfig.responseMimeType "application/json".
 * - Streaming uses `:streamGenerateContent?alt=sse`.
 * - Embeddings use `:batchEmbedContents` so multi-input calls are one request.
 */
import type {
  AdapterInit,
  ChatParams,
  ChatResult,
  EmbedParams,
  EmbedResult,
  LlmHealth,
  LlmMessage,
  LlmProviderAdapter,
  StreamEvent,
} from '../types.js';
import { LlmError } from '../types.js';
import {
  combineSignals,
  errorDetail,
  fetchOrThrow,
  httpStatusToLlmError,
  joinUrl,
  sseData,
  toLlmError,
} from './shared.js';

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GeminiContentPart {
  text?: string;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: GeminiContentPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
}

interface GeminiBatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

interface GeminiModelsResponse {
  models?: Array<{ name?: string }>;
}

/** Gemini REST paths address models as `models/<id>`. */
function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

function mapMessages(messages: LlmMessage[]): {
  systemInstruction: { parts: GeminiContentPart[] } | undefined;
  contents: Array<{ role: 'user' | 'model'; parts: GeminiContentPart[] }>;
} {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.content }],
    }));
  return {
    systemInstruction:
      systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
    contents,
  };
}

function chunkText(chunk: GeminiGenerateResponse): string {
  return (chunk.candidates?.[0]?.content?.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

export function createGeminiAdapter(init: AdapterInit): LlmProviderAdapter {
  const baseUrl = init.baseUrl ?? DEFAULT_GEMINI_BASE_URL;

  const buildHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(init.apiKey !== undefined && init.apiKey !== '' ? { 'x-goog-api-key': init.apiKey } : {}),
    ...init.extraHeaders,
  });

  const buildBody = (params: ChatParams): string => {
    const { systemInstruction, contents } = mapMessages(params.messages);
    const generationConfig: Record<string, unknown> = {};
    if (params.temperature !== undefined) generationConfig['temperature'] = params.temperature;
    if (params.maxTokens !== undefined) generationConfig['maxOutputTokens'] = params.maxTokens;
    if (params.stopSequences !== undefined && params.stopSequences.length > 0) {
      generationConfig['stopSequences'] = params.stopSequences;
    }
    if (params.jsonMode === true) generationConfig['responseMimeType'] = 'application/json';
    const body: Record<string, unknown> = { contents };
    if (systemInstruction !== undefined) body['systemInstruction'] = systemInstruction;
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;
    return JSON.stringify(body);
  };

  const post = async (url: string, body: string, timeoutMs?: number, abortSignal?: AbortSignal): Promise<Response> => {
    const res = await fetchOrThrow(url, {
      method: 'POST',
      headers: buildHeaders(),
      body,
      signal: combineSignals(timeoutMs ?? init.defaultTimeoutMs, abortSignal) ?? null,
    });
    if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
    return res;
  };

  const listModels = async (): Promise<string[]> => {
    const res = await fetchOrThrow(joinUrl(baseUrl, '/v1beta/models'), {
      method: 'GET',
      headers: buildHeaders(),
      signal: combineSignals(init.defaultTimeoutMs, undefined) ?? null,
    });
    if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
    const data = (await res.json().catch(() => ({}))) as GeminiModelsResponse;
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
      .map((name) => (name.startsWith('models/') ? name.slice('models/'.length) : name));
  };

  return {
    kind: 'gemini',

    async chat(params: ChatParams): Promise<ChatResult> {
      const url = joinUrl(baseUrl, `/v1beta/${modelPath(params.model)}:generateContent`);
      const res = await post(url, buildBody(params), params.timeoutMs, params.abortSignal);
      let data: GeminiGenerateResponse;
      try {
        data = (await res.json()) as GeminiGenerateResponse;
      } catch {
        throw new LlmError('Gemini returned invalid JSON for generateContent', 'parse', false);
      }
      return {
        text: chunkText(data),
        model: data.modelVersion ?? params.model,
        inputTokens: data.usageMetadata?.promptTokenCount ?? null,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
        stopReason: data.candidates?.[0]?.finishReason ?? null,
      };
    },

    async *chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, void> {
      const url = joinUrl(baseUrl, `/v1beta/${modelPath(params.model)}:streamGenerateContent?alt=sse`);
      const res = await post(url, buildBody(params), params.timeoutMs, params.abortSignal);
      let text = '';
      let model = params.model;
      let stopReason: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      for await (const payload of sseData(res)) {
        let chunk: GeminiGenerateResponse;
        try {
          chunk = JSON.parse(payload) as GeminiGenerateResponse;
        } catch {
          continue;
        }
        if (typeof chunk.modelVersion === 'string') model = chunk.modelVersion;
        const delta = chunkText(chunk);
        if (delta.length > 0) {
          text += delta;
          yield { type: 'delta', text: delta };
        }
        const finish = chunk.candidates?.[0]?.finishReason;
        if (typeof finish === 'string') stopReason = finish;
        if (chunk.usageMetadata !== undefined) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      }
      yield {
        type: 'done',
        result: { text, model, inputTokens, outputTokens, stopReason },
      };
    },

    async embed(params: EmbedParams): Promise<EmbedResult> {
      const url = joinUrl(baseUrl, `/v1beta/${modelPath(params.model)}:batchEmbedContents`);
      const body = JSON.stringify({
        requests: params.input.map((text) => ({
          model: modelPath(params.model),
          content: { parts: [{ text }] },
        })),
      });
      const res = await post(url, body, params.timeoutMs);
      const data = (await res.json().catch(() => ({}))) as GeminiBatchEmbedResponse;
      return {
        vectors: (data.embeddings ?? []).map((e) => e.values ?? []),
        model: params.model,
        inputTokens: null, // the batch embed endpoint does not report usage
      };
    },

    listModels,

    async healthCheck(model?: string): Promise<LlmHealth> {
      const started = Date.now(); // latency measurement only
      try {
        const models = await listModels();
        const latencyMs = Date.now() - started;
        const bare = model !== undefined && model.startsWith('models/') ? model.slice('models/'.length) : model;
        const modelNote =
          bare !== undefined && models.length > 0 && !models.includes(bare)
            ? ` (note: configured model "${bare}" not in the listed models)`
            : '';
        return {
          ok: true,
          latencyMs,
          message: `reachable — ${models.length} model(s) listed${modelNote}`,
          models,
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const llmErr = toLlmError(err);
        const message =
          llmErr.code === 'auth'
            ? `authentication failed — check the Gemini API key (${llmErr.message})`
            : llmErr.code === 'timeout'
              ? `timed out reaching ${baseUrl}`
              : llmErr.code === 'connection'
                ? `cannot connect to ${baseUrl} — ${llmErr.message}`
                : llmErr.message;
        return { ok: false, latencyMs, message };
      }
    },
  };
}
