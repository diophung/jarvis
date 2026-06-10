/**
 * Text chunking for retrieval indexing.
 *
 * Strategy: split on paragraph boundaries first, then sentences, then
 * hard-split overlong unbroken runs. Consecutive chunks share ~`overlap`
 * trailing/leading characters so retrieval never loses context at a boundary.
 * Pure and deterministic.
 */
import type { ChunkOptions, TextChunk } from './types.js';

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_OVERLAP = 150;

/** Split text into bounded segments: paragraphs, then sentences, then hard slices. */
function buildSegments(text: string, maxSegment: number): string[] {
  const segments: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const p = paragraph.trim();
    if (p === '') continue;
    if (p.length <= maxSegment) {
      segments.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (s === '') continue;
      if (s.length <= maxSegment) {
        segments.push(s);
        continue;
      }
      // Hard-split an unbroken run (e.g. a giant token or minified blob).
      for (let i = 0; i < s.length; i += maxSegment) {
        segments.push(s.slice(i, i + maxSegment));
      }
    }
  }
  return segments;
}

/**
 * Chunk `text` into pieces of at most `chunkSize` characters (default 1200),
 * where consecutive chunks overlap by ~`overlap` characters (default 150).
 * Never returns empty chunks; indexes are sequential from 0.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const overlap = Math.min(
    Math.max(0, Math.floor(opts.overlap ?? DEFAULT_OVERLAP)),
    Math.max(0, chunkSize - 2),
  );
  if (!text || text.trim() === '') return [];

  // Reserve room for the overlap prefix plus a joiner so a freshly started
  // chunk (tail + segment) always fits within chunkSize.
  const maxSegment = Math.max(1, chunkSize - overlap - 1);
  const segments = buildSegments(text, maxSegment);

  const chunks: string[] = [];
  let current = '';
  for (const segment of segments) {
    if (current === '') {
      current = segment;
      continue;
    }
    if (current.length + 1 + segment.length <= chunkSize) {
      current = `${current}\n${segment}`;
      continue;
    }
    chunks.push(current);
    const tail = overlap > 0 ? current.slice(-overlap) : '';
    current = tail === '' ? segment : `${tail}\n${segment}`;
  }
  if (current.trim() !== '') chunks.push(current);

  return chunks
    .filter((c) => c.trim() !== '')
    .map((chunkBody, index) => ({ index, text: chunkBody }));
}
