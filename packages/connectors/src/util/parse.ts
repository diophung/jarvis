/**
 * Small parsing helpers shared by the real connector hooks.
 */
import type { PersonRef } from '@jarvis/core';

/** Parse an RFC 5322-style address ("Jin Park <jin@x.com>" or "jin@x.com"). */
export function parseEmailAddress(value: string): PersonRef {
  const trimmed = value.trim();
  const match = /^(.*)<([^<>@\s]+@[^<>\s]+)>$/.exec(trimmed);
  if (match) {
    const rawName = (match[1] ?? '').trim().replace(/^"|"$/g, '').trim();
    const email = (match[2] ?? '').trim();
    const ref: PersonRef = { email };
    if (rawName) ref.name = rawName;
    return ref;
  }
  if (trimmed.includes('@')) return { email: trimmed };
  return { name: trimmed };
}

/** Parse a comma-separated header value into PersonRefs (naive but practical). */
export function parseEmailAddressList(value: string): PersonRef[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => parseEmailAddress(part));
}

/** Crude HTML-to-text for chat/message bodies returned as HTML. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Parse a JSON cursor string into a plain object, or null when invalid. */
export function parseJsonCursor<T extends Record<string, unknown>>(
  cursor: string | null | undefined,
): T | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a useful error detail from a failed HTTP response: status plus the
 * provider's error message (Google/Microsoft `error.message`, Slack `error`),
 * truncated. Never throws; tolerates empty/non-JSON bodies.
 */
export async function httpErrorDetail(res: {
  status: number;
  text?: () => Promise<string>;
}): Promise<string> {
  let detail = '';
  try {
    const body = res.text ? await res.text() : '';
    if (body) {
      try {
        const parsed = JSON.parse(body) as any;
        detail =
          parsed?.error?.message ??
          (typeof parsed?.error === 'string' ? parsed.error : '') ??
          parsed?.message ??
          '';
      } catch {
        detail = body;
      }
    }
  } catch {}
  detail = String(detail).replace(/\s+/g, ' ').trim().slice(0, 220);
  return detail ? `HTTP ${res.status} — ${detail}` : `HTTP ${res.status}`;
}
