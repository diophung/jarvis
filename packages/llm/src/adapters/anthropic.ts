/**
 * Fetch-based adapter for the Anthropic Messages API (no SDK).
 *
 * - POST {baseUrl}/v1/messages with `x-api-key` + `anthropic-version` headers.
 * - System messages are lifted into the top-level `system` field.
 * - Streaming parses the SSE event payloads (message_start /
 *   content_block_delta / message_delta / message_stop).
 * - Anthropic has no embeddings endpoint, so `embed` is intentionally absent.
 */
import type {
  AdapterInit,
  ChatParams,
  ChatResult,
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

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The Messages API requires max_tokens; used when the caller doesn't set one. */
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicMessageResponse {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

interface AnthropicStreamEvent {
  type?: string;
  message?: {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number } | null;
  };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  error?: { type?: string; message?: string };
}

interface AnthropicModelsResponse {
  data?: Array<{ id?: string }>;
}

function splitMessages(
  messages: LlmMessage[],
  jsonMode: boolean,
): { system: string | undefined; turns: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  if (jsonMode) {
    systemParts.push(
      'Respond with only a single valid JSON object. Do not include prose, explanations, or code fences.',
    );
  }
  const turns = messages
    .filter((m): m is LlmMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    turns,
  };
}

function mapAnthropicStreamError(error: { type?: string; message?: string } | undefined): LlmError {
  const message = error?.message ?? 'unknown stream error';
  switch (error?.type) {
    case 'authentication_error':
    case 'permission_error':
      return new LlmError(message, 'auth', false);
    case 'rate_limit_error':
      return new LlmError(message, 'rate_limit', true);
    case 'invalid_request_error':
      return new LlmError(message, 'bad_request', false);
    case 'overloaded_error':
    case 'api_error':
    default:
      return new LlmError(message, 'server', true);
  }
}

export function createAnthropicAdapter(init: AdapterInit): LlmProviderAdapter {
  const baseUrl = init.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL;

  const buildHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(init.apiKey !== undefined && init.apiKey !== '' ? { 'x-api-key': init.apiKey } : {}),
    ...init.extraHeaders,
  });

  const buildBody = (params: ChatParams, stream: boolean): string => {
    const { system, turns } = splitMessages(params.messages, params.jsonMode === true);
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: turns,
    };
    if (system !== undefined) body['system'] = system;
    if (params.temperature !== undefined) body['temperature'] = params.temperature;
    if (params.stopSequences !== undefined && params.stopSequences.length > 0) {
      body['stop_sequences'] = params.stopSequences;
    }
    if (stream) body['stream'] = true;
    return JSON.stringify(body);
  };

  const postMessages = async (params: ChatParams, stream: boolean): Promise<Response> => {
    const res = await fetchOrThrow(joinUrl(baseUrl, '/v1/messages'), {
      method: 'POST',
      headers: buildHeaders(),
      body: buildBody(params, stream),
      signal: combineSignals(params.timeoutMs ?? init.defaultTimeoutMs, params.abortSignal) ?? null,
    });
    if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
    return res;
  };

  const listModels = async (): Promise<string[]> => {
    const res = await fetchOrThrow(joinUrl(baseUrl, '/v1/models'), {
      method: 'GET',
      headers: buildHeaders(),
      signal: combineSignals(init.defaultTimeoutMs, undefined) ?? null,
    });
    if (!res.ok) throw httpStatusToLlmError(res.status, await errorDetail(res));
    const data = (await res.json().catch(() => ({}))) as AnthropicModelsResponse;
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  };

  return {
    kind: 'anthropic',

    async chat(params: ChatParams): Promise<ChatResult> {
      const res = await postMessages(params, false);
      let data: AnthropicMessageResponse;
      try {
        data = (await res.json()) as AnthropicMessageResponse;
      } catch {
        throw new LlmError('Anthropic returned invalid JSON for /v1/messages', 'parse', false);
      }
      const text = (data.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text ?? '')
        .join('');
      return {
        text,
        model: data.model ?? params.model,
        inputTokens: data.usage?.input_tokens ?? null,
        outputTokens: data.usage?.output_tokens ?? null,
        stopReason: data.stop_reason ?? null,
      };
    },

    async *chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, void> {
      const res = await postMessages(params, true);
      let text = '';
      let model = params.model;
      let stopReason: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      for await (const payload of sseData(res)) {
        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(payload) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        switch (event.type) {
          case 'message_start': {
            if (typeof event.message?.model === 'string') model = event.message.model;
            inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
            break;
          }
          case 'content_block_delta': {
            if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
              text += event.delta.text;
              yield { type: 'delta', text: event.delta.text };
            }
            break;
          }
          case 'message_delta': {
            if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            break;
          }
          case 'error':
            throw mapAnthropicStreamError(event.error);
          case 'message_stop':
          case 'content_block_start':
          case 'content_block_stop':
          case 'ping':
          default:
            break;
        }
      }
      yield {
        type: 'done',
        result: { text, model, inputTokens, outputTokens, stopReason },
      };
    },

    // No `embed`: the Anthropic API does not offer an embeddings endpoint.

    listModels,

    async healthCheck(model?: string): Promise<LlmHealth> {
      const started = Date.now(); // latency measurement only
      try {
        const res = await fetchOrThrow(joinUrl(baseUrl, '/v1/models'), {
          method: 'GET',
          headers: buildHeaders(),
          signal: combineSignals(init.defaultTimeoutMs ?? 10_000, undefined) ?? null,
        });
        const latencyMs = Date.now() - started;
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            latencyMs,
            message: `authentication failed (HTTP ${res.status}) — check the Anthropic API key`,
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
        const data = (await res.json().catch(() => ({}))) as AnthropicModelsResponse;
        const models = (data.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const modelNote =
          model !== undefined && models.length > 0 && !models.includes(model)
            ? ` (note: configured model "${model}" not in the listed models)`
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
            ? `timed out reaching ${baseUrl}`
            : llmErr.code === 'connection'
              ? `cannot connect to ${baseUrl} — ${llmErr.message}`
              : llmErr.message;
        return { ok: false, latencyMs, message };
      }
    },
  };
}
