/**
 * Hybrid retrieval over retrieval_chunks:
 *
 * - Keyword leg: SQL LIKE candidate scan, scored by matched-token count with
 *   a title-match bonus and a recency tiebreak.
 * - Semantic leg (only when an embedding provider is configured): cosine
 *   similarity between the embedded query and the newest stored embeddings.
 *
 * Legs are merged per chunk (normalized keyword * 0.5 + cosine * 0.5),
 * deduped to the best chunk per referenced entity, and capped at `limit`.
 */
import { fromJson, type SourceCategory } from '@donna/core';
import type { Db } from '@donna/db';
import type { LlmRouterService, RetrievalService, SearchResult, VectorStore } from '../context.js';

const MAX_TOKENS = 8;
const MIN_TOKEN_LENGTH = 3;
const KEYWORD_CANDIDATE_LIMIT = 500;
const SEMANTIC_HIT_LIMIT = 60;
const MIN_COSINE = 0.2;
const DEFAULT_LIMIT = 20;
const SNIPPET_LENGTH = 200;
const TOKEN_MATCH_WEIGHT = 2;
const TITLE_MATCH_BONUS = 3;

interface ChunkMetadata {
  title?: string;
  sourceLabel?: string;
  category?: SourceCategory;
  url?: string;
}

interface CandidateChunk {
  id: string;
  sourceType: string;
  refId: string;
  text: string;
  createdAt: string;
}

interface Candidate {
  chunk: CandidateChunk;
  meta: ChunkMetadata;
  keywordScore: number;
  matchedTokens: string[];
  cosine: number;
}

/** Lowercased alphanumeric tokens, >=3 chars, deduped, capped at 8. */
export function tokenize(query: string): string[] {
  const matches = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const seen = new Set<string>();
  for (const token of matches) {
    if (seen.size >= MAX_TOKENS) break;
    if (token.length >= MIN_TOKEN_LENGTH) seen.add(token);
  }
  return [...seen];
}

/** ~200 chars centered on the first matched token (start of text when none match). */
export function makeSnippet(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  let firstIdx = -1;
  for (const token of tokens) {
    const i = lower.indexOf(token);
    if (i !== -1 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
  }
  if (firstIdx === -1) return text.slice(0, SNIPPET_LENGTH);
  const start = Math.max(0, firstIdx - Math.floor(SNIPPET_LENGTH / 2));
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function createRetrievalService(deps: {
  db: Db;
  llm: LlmRouterService;
  vectors: VectorStore;
}): RetrievalService {
  const { db, llm, vectors } = deps;

  return {
    async search(workspaceId, query, opts = {}) {
      const tokens = tokenize(query);
      const limit = opts.limit ?? DEFAULT_LIMIT;
      const candidates = new Map<string, Candidate>();

      // ---- Keyword leg
      if (tokens.length > 0) {
        let q = db
          .selectFrom('retrievalChunks')
          .select(['id', 'sourceType', 'refId', 'text', 'metadata', 'createdAt'])
          .where('workspaceId', '=', workspaceId);
        if (opts.sourceTypes !== undefined && opts.sourceTypes.length > 0) {
          q = q.where('sourceType', 'in', opts.sourceTypes);
        }
        // Tokens are alphanumeric (no LIKE wildcards). SQLite LIKE is
        // case-insensitive for ASCII; metadata is matched too so title-only
        // hits become candidates.
        q = q.where((eb) =>
          eb.or([
            ...tokens.map((t) => eb('text', 'like', `%${t}%`)),
            ...tokens.map((t) => eb('metadata', 'like', `%${t}%`)),
          ]),
        );
        const rows = await q
          .orderBy('createdAt', 'desc')
          .limit(KEYWORD_CANDIDATE_LIMIT)
          .execute();
        for (const row of rows) {
          const meta = fromJson<ChunkMetadata>(row.metadata, {});
          const lowerText = row.text.toLowerCase();
          const matchedTokens = tokens.filter((t) => lowerText.includes(t));
          const lowerTitle = (meta.title ?? '').toLowerCase();
          const titleMatch = tokens.some((t) => lowerTitle.includes(t));
          const keywordScore =
            matchedTokens.length * TOKEN_MATCH_WEIGHT + (titleMatch ? TITLE_MATCH_BONUS : 0);
          if (keywordScore <= 0) continue;
          candidates.set(row.id, {
            chunk: {
              id: row.id,
              sourceType: row.sourceType,
              refId: row.refId,
              text: row.text,
              createdAt: row.createdAt,
            },
            meta,
            keywordScore,
            matchedTokens,
            cosine: 0,
          });
        }
      }

      // ---- Semantic leg (only when an embedding provider is configured).
      // Vector ranking goes through the VectorStore abstraction (SQL scan or
      // pgvector); a vector-backend failure degrades to keyword-only.
      let mode: 'keyword' | 'semantic+keyword' = 'keyword';
      const ec = await llm.embeddingClient(workspaceId);
      if (ec !== null) {
        try {
          const embedded = await ec.client.embed({ model: ec.model, input: [query] });
          const queryVector = embedded.vectors[0];
          if (queryVector === undefined) throw new Error('embedding returned no vectors');

          const searchOpts: Parameters<typeof vectors.search>[3] = {
            limit: Math.max(limit * 3, SEMANTIC_HIT_LIMIT),
            minCosine: MIN_COSINE,
          };
          if (opts.sourceTypes !== undefined && opts.sourceTypes.length > 0) {
            searchOpts.sourceTypes = opts.sourceTypes;
          }
          const hits = await vectors.search(workspaceId, ec.model, queryVector, searchOpts);

          mode = 'semantic+keyword';
          for (const hit of hits) {
            const existing = candidates.get(hit.chunkId);
            if (existing !== undefined) {
              existing.cosine = Math.max(existing.cosine, hit.cosine);
            } else {
              candidates.set(hit.chunkId, {
                chunk: {
                  id: hit.chunkId,
                  sourceType: hit.sourceType,
                  refId: hit.refId,
                  text: hit.text,
                  createdAt: hit.createdAt,
                },
                meta: fromJson<ChunkMetadata>(hit.metadata, {}),
                keywordScore: 0,
                matchedTokens: [],
                cosine: hit.cosine,
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[retrieval] semantic leg failed; using keyword only: ${message}`);
          mode = 'keyword';
        }
      }

      // ---- Merge, rank, dedupe per referenced entity
      let list = [...candidates.values()];
      if (opts.categories !== undefined && opts.categories.length > 0) {
        const cats = new Set<string>(opts.categories);
        list = list.filter((c) => c.meta.category !== undefined && cats.has(c.meta.category));
      }
      const maxKeyword = list.reduce((max, c) => Math.max(max, c.keywordScore), 0);
      const scored = list.map((c) => {
        const keywordNorm = maxKeyword > 0 ? c.keywordScore / maxKeyword : 0;
        const score = keywordNorm * 0.5 + c.cosine * 0.5;
        const matchType: SearchResult['matchType'] =
          c.keywordScore > 0 && c.cosine > 0 ? 'both' : c.cosine > 0 ? 'semantic' : 'keyword';
        return { c, score, matchType };
      });
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Recency tiebreak (ISO strings compare lexicographically).
        return b.c.chunk.createdAt.localeCompare(a.c.chunk.createdAt);
      });

      const results: SearchResult[] = [];
      const seenRefs = new Set<string>();
      for (const { c, score, matchType } of scored) {
        const refKey = `${c.chunk.sourceType}:${c.chunk.refId}`;
        if (seenRefs.has(refKey)) continue;
        seenRefs.add(refKey);
        results.push({
          chunkId: c.chunk.id,
          sourceType: c.chunk.sourceType as SearchResult['sourceType'],
          refId: c.chunk.refId,
          title: c.meta.title ?? '',
          snippet: makeSnippet(c.chunk.text, c.matchedTokens.length > 0 ? c.matchedTokens : tokens),
          score,
          matchType,
          sourceLabel: c.meta.sourceLabel,
          category: c.meta.category,
          url: c.meta.url,
        });
        if (results.length >= limit) break;
      }

      return { results, mode };
    },
  };
}
