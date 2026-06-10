import { describe, expect, it } from 'vitest';
import type { RawSourceItem } from './types.js';
import { fnv1a64, normalizeRawItem } from './normalize.js';

function rawItem(overrides: Partial<RawSourceItem> = {}): RawSourceItem {
  return {
    externalId: 'ext-1',
    category: 'email',
    title: 'Budget Review',
    bodyText: 'Please review the attached budget before Friday.',
    sender: { name: 'Alex Kim', email: 'alex@acme.com' },
    timestamp: '2026-06-09T10:00:00Z',
    ...overrides,
  };
}

describe('fnv1a64', () => {
  it('matches canonical FNV-1a 64 test vectors for ASCII input', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });

  it('is deterministic and produces 16-char lowercase hex', () => {
    const h1 = fnv1a64('donna executive assistant');
    const h2 = fnv1a64('donna executive assistant');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different inputs, including non-ASCII', () => {
    expect(fnv1a64('abc')).not.toBe(fnv1a64('abd'));
    expect(fnv1a64('café')).not.toBe(fnv1a64('cafe'));
  });
});

describe('normalizeRawItem', () => {
  it('trims and collapses the title', () => {
    const n = normalizeRawItem(rawItem({ title: '  Budget \n  Review  ' }));
    expect(n.title).toBe('Budget Review');
  });

  it('uses dedupeHint verbatim when provided', () => {
    const n = normalizeRawItem(rawItem({ dedupeHint: 'ics-uid-12345' }));
    expect(n.dedupeKey).toBe('ics-uid-12345');
  });

  it('produces the same dedupeKey for same title/day/sender despite case and spacing', () => {
    const a = normalizeRawItem(
      rawItem({ title: 'Budget Review', timestamp: '2026-06-09T10:00:00Z' }),
    );
    const b = normalizeRawItem(
      rawItem({
        externalId: 'ext-2',
        title: '  budget   REVIEW ',
        timestamp: '2026-06-09T22:30:00Z', // same day, different time
        sender: { name: 'A. Kim', email: 'ALEX@acme.com' },
      }),
    );
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  it('produces a different dedupeKey for a different day', () => {
    const a = normalizeRawItem(rawItem({ timestamp: '2026-06-09T10:00:00Z' }));
    const b = normalizeRawItem(rawItem({ timestamp: '2026-06-10T10:00:00Z' }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('produces a different dedupeKey for a different sender', () => {
    const a = normalizeRawItem(rawItem());
    const b = normalizeRawItem(rawItem({ sender: { email: 'someone-else@acme.com' } }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('derives a whitespace-collapsed snippet of at most 200 chars from bodyText', () => {
    const body = `First   line\n\nsecond\tline ${'x'.repeat(300)}`;
    const n = normalizeRawItem(rawItem({ bodyText: body, snippet: undefined }));
    expect(n.snippet).not.toBeNull();
    expect(n.snippet!.length).toBeLessThanOrEqual(200);
    expect(n.snippet!.startsWith('First line second line')).toBe(true);
    expect(n.snippet).not.toMatch(/\n/);
  });

  it('keeps a provided snippet (collapsed) instead of deriving one', () => {
    const n = normalizeRawItem(rawItem({ snippet: '  Provider   snippet  ' }));
    expect(n.snippet).toBe('Provider snippet');
  });

  it('returns null snippet and bodyText when body is missing or blank', () => {
    const n = normalizeRawItem(rawItem({ bodyText: '   ', snippet: undefined }));
    expect(n.bodyText).toBeNull();
    expect(n.snippet).toBeNull();
  });

  it('keeps a valid ISO timestamp as itemTimestamp', () => {
    const n = normalizeRawItem(rawItem({ timestamp: '2026-06-09T10:00:00Z' }));
    expect(n.itemTimestamp).toBe('2026-06-09T10:00:00Z');
  });

  it('falls back to startsAt then dueAt when timestamp is not valid ISO', () => {
    const viaStarts = normalizeRawItem(
      rawItem({ timestamp: 'not-a-date', startsAt: '2026-06-11T09:00:00Z' }),
    );
    expect(viaStarts.itemTimestamp).toBe('2026-06-11T09:00:00Z');

    const viaDue = normalizeRawItem(
      rawItem({ timestamp: 'not-a-date', dueAt: '2026-06-12T17:00:00Z' }),
    );
    expect(viaDue.itemTimestamp).toBe('2026-06-12T17:00:00Z');
  });

  it('keeps the raw timestamp verbatim when nothing parses (callers pre-validate)', () => {
    const n = normalizeRawItem(rawItem({ timestamp: 'garbage' }));
    expect(n.itemTimestamp).toBe('garbage');
  });

  it('maps isRead boolean to 0|1 (default 0)', () => {
    expect(normalizeRawItem(rawItem({ isRead: true })).isRead).toBe(1);
    expect(normalizeRawItem(rawItem({ isRead: false })).isRead).toBe(0);
    expect(normalizeRawItem(rawItem()).isRead).toBe(0);
  });

  it('computes contentHash from title + body + timestamp and changes with body', () => {
    const a = normalizeRawItem(rawItem({ bodyText: 'one' }));
    const b = normalizeRawItem(rawItem({ bodyText: 'two' }));
    const a2 = normalizeRawItem(rawItem({ bodyText: 'one' }));
    expect(a.contentHash).toBe(a2.contentHash);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('lowercases sender email and drops empty person refs and labels', () => {
    const n = normalizeRawItem(
      rawItem({
        sender: { name: '  Alex Kim ', email: ' ALEX@Acme.com ' },
        participants: [{ email: 'B@x.com' }, { name: '   ' }],
        labels: [' inbox ', '', 'inbox', 'urgent'],
      }),
    );
    expect(n.sender).toEqual({ name: 'Alex Kim', email: 'alex@acme.com' });
    expect(n.participants).toEqual([{ email: 'b@x.com' }]);
    expect(n.labels).toEqual(['inbox', 'urgent']);
  });

  it('defaults collections and metadata, and trims scalar fields', () => {
    const n = normalizeRawItem(
      rawItem({
        externalId: ' ext-9 ',
        url: ' https://example.com/x ',
        threadExternalId: '  ',
        dueAt: undefined,
      }),
    );
    expect(n.externalId).toBe('ext-9');
    expect(n.url).toBe('https://example.com/x');
    expect(n.threadExternalId).toBeNull();
    expect(n.dueAt).toBeNull();
    expect(n.participants).toEqual([]);
    expect(n.labels).toEqual([]);
    expect(n.rawMetadata).toEqual({});
    expect(n.attachments).toEqual([]);
  });
});
