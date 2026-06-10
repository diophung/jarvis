/**
 * Schema-validated structured generation on top of LlmClient.
 *
 * generateStructured builds a system instruction demanding ONLY JSON matching
 * the supplied description, calls chat with jsonMode, extracts the first JSON
 * object from the response (tolerating ```json fences and leading prose), and
 * validates it with zod. On failure it retries once, appending the validation
 * error; if the retry also fails it returns `{ value: fallback ?? null, raw,
 * error }`. Parse/validation failures NEVER throw.
 */
import type { z } from 'zod';
import type { LlmClient } from './client.js';
import type { ChatParams, LlmMessage } from './types.js';

export interface StructuredOptions<T> {
  schema: z.ZodType<T>;
  schemaName: string;
  schemaDescription: string;
  fallback?: T;
}

export interface StructuredResult<T> {
  value: T | null;
  raw: string;
  error?: string;
}

/**
 * Extract the first JSON object from model output. Handles ```json fences,
 * bare ``` fences, and leading/trailing prose, with string-aware brace
 * matching so braces inside JSON strings don't confuse the scan.
 */
export function extractJsonObject(text: string): string | null {
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  const candidate = fenceMatch?.[1] ?? text;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export async function generateStructured<T>(
  client: LlmClient,
  baseParams: ChatParams,
  opts: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const instruction = [
    `You are generating a JSON document named "${opts.schemaName}".`,
    `Description of the expected shape: ${opts.schemaDescription}`,
    'Respond with ONLY a single JSON object matching that description.',
    'Do not include prose, explanations, markdown fences, or any text outside the JSON object.',
  ].join('\n');

  const baseMessages: LlmMessage[] = [
    { role: 'system', content: instruction },
    ...baseParams.messages,
  ];

  let raw = '';
  let lastError = 'no response';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages: LlmMessage[] =
      attempt === 0
        ? baseMessages
        : [
            ...baseMessages,
            { role: 'assistant', content: raw },
            {
              role: 'user',
              content: [
                `Your previous response was invalid: ${lastError}.`,
                `Respond again with ONLY a single valid JSON object matching the "${opts.schemaName}" description. No other text.`,
              ].join('\n'),
            },
          ];

    const result = await client.chat({ ...baseParams, messages, jsonMode: true });
    raw = result.text;

    const extracted = extractJsonObject(raw);
    if (extracted === null) {
      lastError = 'no JSON object found in the response';
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted);
    } catch (err) {
      lastError = `response is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
      continue;
    }
    const validated = opts.schema.safeParse(parsed);
    if (validated.success) {
      return { value: validated.data, raw };
    }
    lastError = `schema validation failed: ${formatZodError(validated.error)}`;
  }

  return { value: opts.fallback ?? null, raw, error: lastError };
}
