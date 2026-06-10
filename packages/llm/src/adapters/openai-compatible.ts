/**
 * Adapter for any OpenAI-compatible chat-completions endpoint: OpenAI cloud,
 * vLLM, Ollama (/v1), SGLang, LM Studio, llama.cpp server, OpenRouter, ...
 *
 * Quirk handling for local servers:
 * - `response_format: {type:'json_object'}` is retried once without the field
 *   when the server rejects it with a 400 (several local servers don't
 *   implement it).
 * - `stream_options: {include_usage: true}` is requested best-effort; missing
 *   usage in the stream is tolerated.
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
import {
  combineSignals,
  errorDetail,
  fetchOrThrow,
  httpStatusToLlmError,
  joinUrl,
  sseData,
  toLlmError,
} from './shared.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1';

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

interface OpenAiStreamChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

interface OpenAiEmbeddingResponse {
  model?: string;
  data?: Array<{ index?: number; embedding?: number[] }>;
  usage?: { prompt_tokens?: number } | null;
}

interface OpenAiModelsResponse {
  data?: Array<{ id?: string }>;
}

export function createOpenAiCompatibleAdapter(
  init: AdapterInit,
  kind: 'openai' | 'openai_compatible' = 'openai_compatible',
): LlmProviderAdapter {
  const baseUrl =
    init.baseUrl ?? (kind === 'openai' ? DEFAULT_OPENAI_BASE_URL : DEFAULT_OPENAI_COMPATIBLE_BASE_URL);

  const buildHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(init.apiKey !== undefined && init.apiKey !== '' ? { authorization: `Bearer ${init.apiKey}` } : {}),
    ...init.extraHeaders,
  });

  const buildChatBody = (params: ChatParams, stream: boolean, withJsonFormat: boolean): string => {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
    };
    if (params.temperature !== undefined) body['temperature'] = params.temperature;
    if (params.maxTokens !== undefined) body['max_tokens'] = params.maxTokens;
    if (params.stopSequences !== undefined && params.stopSequences.length > 0) {
      body['stop'] = params.stopSequences;
    }
    if (withJsonFormat) body['response_format'] = { type: 'json_object' };
    if (stream) body['stream_options'] = { include_usage: true };
    return JSON.stringify(body);
  };

  /**
   * POST /chat/completions; when jsonMode caused a 400, retry once without
   * response_format (some local servers reject it).
   */
  const postChat = async (params: ChatParams, stream: boolean): Promise<Response> => {
    const url = joinUrl(baseUrl, '/chat/completions');
    const signal = combineSignals(params.timeoutMs ?? init.defaultTimeoutMs, params.abortSignal);
    const wantJson = params.jsonMode === true;
    let res = await fetchOrThrow(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: buildChatBody(params, stream, wantJson),
      signal: signal ?? null,
    });
    if (!res.ok && res.status === 400 && wantJson) {
      res = await fetchOrThrow(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: buildChatBody(params, stream, false),
        signal: signal ?? null,
      });
    }
    if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
    return res;
  };

  const listModels = async (): Promise<string[]> => {
    const res = await fetchOrThrow(joinUrl(baseUrl, '/models'), {
      method: 'GET',
      headers: buildHeaders(),
      signal: combineSignals(init.defaultTimeoutMs, undefined) ?? null,
    });
    if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
    const data = (await res.json().catch(() => ({}))) as OpenAiModelsResponse;
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  };

  return {
    kind,

    async chat(params: ChatParams): Promise<ChatResult> {
      const res = await postChat(params, false);
      let data: OpenAiChatResponse;
      try {
        data = (await res.json()) as OpenAiChatResponse;
      } catch {
        throw toLlmError(new Error('provider returned invalid JSON for chat completion'));
      }
      const choice = data.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        model: data.model ?? params.model,
        inputTokens: data.usage?.prompt_tokens ?? null,
        outputTokens: data.usage?.completion_tokens ?? null,
        stopReason: choice?.finish_reason ?? null,
      };
    },

    async *chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, void> {
      const res = await postChat(params, true);
      let text = '';
      let model = params.model;
      let stopReason: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      for await (const payload of sseData(res)) {
        if (payload === '[DONE]') break;
        let chunk: OpenAiStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiStreamChunk;
        } catch {
          continue; // tolerate malformed keep-alive lines
        }
        if (typeof chunk.model === 'string' && chunk.model.length > 0) model = chunk.model;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          text += delta;
          yield { type: 'delta', text: delta };
        }
        if (typeof choice?.finish_reason === 'string') stopReason = choice.finish_reason;
        if (chunk.usage !== undefined && chunk.usage !== null) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }
      yield {
        type: 'done',
        result: { text, model, inputTokens, outputTokens, stopReason },
      };
    },

    async embed(params: EmbedParams): Promise<EmbedResult> {
      const res = await fetchOrThrow(joinUrl(baseUrl, '/embeddings'), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ model: params.model, input: params.input }),
        signal: combineSignals(params.timeoutMs ?? init.defaultTimeoutMs, undefined) ?? null,
      });
      if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
      const data = (await res.json().catch(() => ({}))) as OpenAiEmbeddingResponse;
      const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return {
        vectors: rows.map((row) => row.embedding ?? []),
        model: data.model ?? params.model,
        inputTokens: data.usage?.prompt_tokens ?? null,
      };
    },

    listModels,

    async healthCheck(model?: string): Promise<LlmHealth> {
      const started = Date.now(); // latency measurement only
      try {
        const res = await fetchOrThrow(joinUrl(baseUrl, '/models'), {
          method: 'GET',
          headers: buildHeaders(),
          signal: combineSignals(init.defaultTimeoutMs ?? 10_000, undefined) ?? null,
        });
        const latencyMs = Date.now() - started;
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            latencyMs,
            message: `authentication failed (HTTP ${res.status}) — check the API key for ${baseUrl}`,
          };
        }
        if (!res.ok) {
          const detail = await errorDetail(res);
          return {
            ok: false,
            latencyMs,
            message: `unexpected HTTP ${res.status} from ${baseUrl}${detail.length > 0 ? `: ${detail}` : ''}`,
          };
        }
        const data = (await res.json().catch(() => ({}))) as OpenAiModelsResponse;
        const models = (data.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const modelNote =
          model !== undefined && models.length > 0 && !models.includes(model)
            ? ` (note: configured model "${model}" not in the server's model list)`
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
          llmErr.code === 'timeout'
            ? `timed out reaching ${baseUrl} — is the server running?`
            : llmErr.code === 'connection'
              ? `cannot connect to ${baseUrl} — ${llmErr.message}`
              : llmErr.message;
        return { ok: false, latencyMs, message };
      }
    },
  };
}
