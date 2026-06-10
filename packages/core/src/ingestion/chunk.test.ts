import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('returns [] for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual([{ index: 0, text: 'hello world' }]);
  });

  it('never produces empty chunks and keeps indexes sequential from 0', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i} with some words.`)
      .join('\n\n');
    const chunks = chunkText(text, { chunkSize: 120, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.text.trim()).not.toBe('');
    });
  });

  it('respects the chunkSize limit', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Para ${i} ${'word '.repeat(10)}`).join(
      '\n\n',
    );
    for (const c of chunkText(text, { chunkSize: 100, overlap: 15 })) {
      expect(c.text.length).toBeLessThanOrEqual(100);
    }
  });

  it('overlaps consecutive chunks by ~overlap chars', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} about topic ${i}.`).join(
      '\n\n',
    );
    const overlap = 20;
    const chunks = chunkText(text, { chunkSize: 90, overlap });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.text;
      const tail = prev.slice(-overlap);
      expect(chunks[i]!.text.startsWith(tail)).toBe(true);
    }
  });

  it('uses default chunkSize 1200 and overlap 150', () => {
    const text = Array.from(
      { length: 60 },
      (_, i) => `Sentence ${i} of a long memo that goes on for quite a while, covering details.`,
    ).join(' ');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1200);
    const tail = chunks[0]!.text.slice(-150);
    expect(chunks[1]!.text.startsWith(tail)).toBe(true);
  });

  it('splits sentences when a paragraph is too long', () => {
    const paragraph = Array.from(
      { length: 12 },
      (_, i) => `This is sentence ${i} talking about a project milestone.`,
    ).join(' ');
    const chunks = chunkText(paragraph, { chunkSize: 150, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(150);
  });

  it('hard-splits an unbroken overlong run without producing empty or oversized chunks', () => {
    const text = 'x'.repeat(5000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.text.length).toBeLessThanOrEqual(1200);
    }
    // overlap still holds across hard-split boundaries
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1]!.text.slice(-150);
      expect(chunks[i]!.text.startsWith(tail)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const text = Array.from({ length: 25 }, (_, i) => `Block ${i}. More detail here.`).join('\n\n');
    expect(chunkText(text, { chunkSize: 80, overlap: 10 })).toEqual(
      chunkText(text, { chunkSize: 80, overlap: 10 }),
    );
  });

  it('tolerates degenerate options (tiny chunkSize, oversized overlap)', () => {
    const chunks = chunkText('alpha beta gamma delta', { chunkSize: 8, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.text.trim()).not.toBe('');
      expect(c.text.length).toBeLessThanOrEqual(8);
    }
  });
});
