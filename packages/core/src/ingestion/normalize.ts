/**
 * Normalization pipeline: converts connector-emitted RawSourceItem payloads
 * into clean NormalizedItemInput records with derived snippets, dedupe keys,
 * and content hashes.
 *
 * Pure and deterministic: never reads the wall clock; every timestamp comes
 * from the raw item itself.
 */
import type { PersonRef } from '../entities.js';
import type { NormalizedItemInput, RawSourceItem } from './types.js';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * FNV-1a 64-bit hash returned as a 16-char lowercase hex string.
 * Pure TypeScript (BigInt), no node:crypto. For pure-ASCII input the result
 * matches the canonical byte-oriented FNV-1a 64 test vectors; non-ASCII code
 * units are folded in as (low byte, high byte) pairs, which keeps the function
 * deterministic and stable across platforms.
 */
export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    hash ^= BigInt(code & 0xff);
    hash = (hash * FNV_PRIME) & MASK_64;
    const hi = code >>> 8;
    if (hi !== 0) {
      hash ^= BigInt(hi);
      hash = (hash * FNV_PRIME) & MASK_64;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

const SNIPPET_MAX_LENGTH = 200;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cleanOptional(s: string | undefined): string | null {
  if (s === undefined) return null;
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

function cleanPersonRef(ref: PersonRef | undefined | null): PersonRef | null {
  if (!ref) return null;
  const out: PersonRef = {};
  const name = ref.name?.trim();
  if (name) out.name = name;
  const email = ref.email?.trim().toLowerCase();
  if (email) out.email = email;
  const handle = ref.handle?.trim();
  if (handle) out.handle = handle;
  if (ref.personId) out.personId = ref.personId;
  return Object.keys(out).length > 0 ? out : null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

function isValidIso(s: string | undefined): boolean {
  if (s === undefined) return false;
  const trimmed = s.trim();
  return ISO_DATE_RE.test(trimmed) && !Number.isNaN(Date.parse(trimmed));
}

/**
 * Normalize a raw connector item.
 *
 * - Fields are trimmed; the title has internal whitespace collapsed.
 * - `snippet` is derived from the first ~200 chars of whitespace-collapsed
 *   bodyText when the connector did not provide one.
 * - `itemTimestamp`: `raw.timestamp` is used when it is a parseable ISO date;
 *   otherwise we fall back to `raw.startsAt ?? raw.dueAt`. Callers are expected
 *   to pre-validate timestamps — if nothing parses, the raw value is kept
 *   verbatim so the problem stays visible upstream.
 * - `dedupeKey`: the provider hint wins; otherwise a deterministic FNV-1a 64
 *   hash of category, lowercased/collapsed title, the timestamp's calendar day
 *   (YYYY-MM-DD), and the sender email (or '').
 */
export function normalizeRawItem(raw: RawSourceItem): NormalizedItemInput {
  const title = collapseWhitespace(raw.title);
  const bodyText = cleanOptional(raw.bodyText);

  const providedSnippet = raw.snippet ? collapseWhitespace(raw.snippet) : '';
  const snippet =
    providedSnippet !== ''
      ? providedSnippet.slice(0, SNIPPET_MAX_LENGTH)
      : bodyText !== null
        ? collapseWhitespace(bodyText).slice(0, SNIPPET_MAX_LENGTH).trimEnd()
        : null;

  const itemTimestamp = isValidIso(raw.timestamp)
    ? raw.timestamp.trim()
    : isValidIso(raw.startsAt) && raw.startsAt !== undefined
      ? raw.startsAt.trim()
      : isValidIso(raw.dueAt) && raw.dueAt !== undefined
        ? raw.dueAt.trim()
        : raw.timestamp.trim();

  const sender = cleanPersonRef(raw.sender);
  const participants = (raw.participants ?? [])
    .map((p) => cleanPersonRef(p))
    .filter((p): p is PersonRef => p !== null);

  const dedupeHint = raw.dedupeHint?.trim();
  const timestampDay = itemTimestamp.slice(0, 10);
  const dedupeKey =
    dedupeHint !== undefined && dedupeHint !== ''
      ? dedupeHint
      : fnv1a64(
          `${raw.category}|${title.toLowerCase()}|${timestampDay}|${sender?.email ?? ''}`,
        );

  const contentHash = fnv1a64(title + (bodyText ?? '') + itemTimestamp);

  const labels = [...new Set((raw.labels ?? []).map(collapseWhitespace).filter((l) => l !== ''))];

  return {
    externalId: raw.externalId.trim(),
    category: raw.category,
    title,
    bodyText,
    snippet,
    sender,
    participants,
    itemTimestamp,
    dueAt: cleanOptional(raw.dueAt),
    startsAt: cleanOptional(raw.startsAt),
    endsAt: cleanOptional(raw.endsAt),
    url: cleanOptional(raw.url),
    threadExternalId: cleanOptional(raw.threadExternalId),
    labels,
    rawMetadata: raw.raw ?? {},
    dedupeKey,
    contentHash,
    isRead: raw.isRead === true ? 1 : 0,
    attachments: raw.attachments ?? [],
  };
}
