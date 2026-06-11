/**
 * Indexing: chunk text into retrieval_chunks and (best-effort) embed the
 * chunks when an embedding provider is configured. Embedding failures never
 * fail indexing — keyword chunks remain searchable on their own. Vector
 * persistence goes through the VectorStore abstraction (SQL scan or
 * pgvector — see services/vector-store.ts).
 */
import { chunkText, newId, nowIso, toJson } from '@donna/core';
import type { Db } from '@donna/db';
import type { IndexingService, LlmRouterService, VectorStore } from '../context.js';

const INSERT_BATCH = 50;
const DELETE_BATCH = 500;

async function deleteIndexFor(
  db: Db,
  vectors: VectorStore,
  sourceType: string,
  refId: string,
): Promise<void> {
  const chunkRows = await db
    .selectFrom('retrievalChunks')
    .select('id')
    .where('sourceType', '=', sourceType)
    .where('refId', '=', refId)
    .execute();
  const ids = chunkRows.map((r) => r.id);
  if (ids.length === 0) return;
  await vectors.removeByChunkIds(ids);
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    await db
      .deleteFrom('retrievalChunks')
      .where('id', 'in', ids.slice(i, i + DELETE_BATCH))
      .execute();
  }
}

export function createIndexingService(deps: {
  db: Db;
  llm: LlmRouterService;
  vectors: VectorStore;
}): IndexingService {
  const { db, llm, vectors } = deps;

  return {
    async indexText(workspaceId, sourceType, refId, text, metadata) {
      // Replace any previous index for this ref.
      await deleteIndexFor(db, vectors, sourceType, refId);

      const chunks = chunkText(text);
      if (chunks.length === 0) return { chunks: 0, embedded: false };

      const now = nowIso();
      const metadataJson = toJson(metadata);
      const rows = chunks.map((chunk) => ({
        id: newId('chk'),
        workspaceId,
        sourceType,
        refId,
        chunkIndex: chunk.index,
        text: chunk.text,
        metadata: metadataJson,
        createdAt: now,
      }));
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await db
          .insertInto('retrievalChunks')
          .values(rows.slice(i, i + INSERT_BATCH))
          .execute();
      }

      const ec = await llm.embeddingClient(workspaceId);
      if (ec === null) return { chunks: rows.length, embedded: false };

      try {
        const result = await ec.client.embed({
          model: ec.model,
          input: rows.map((r) => r.text),
        });
        if (result.vectors.length !== rows.length) {
          throw new Error(
            `embedding count mismatch: got ${result.vectors.length}, expected ${rows.length}`,
          );
        }
        await vectors.upsert(
          workspaceId,
          rows.map((row, i) => {
            const vector = result.vectors[i];
            if (vector === undefined) throw new Error(`missing embedding vector at index ${i}`);
            return {
              chunkId: row.id,
              providerConfigId: ec.providerConfigId,
              model: result.model,
              vector,
            };
          }),
        );
        return { chunks: rows.length, embedded: true };
      } catch (err) {
        // Best-effort: log (no content) and keep the keyword chunks.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[indexing] embedding failed for ${sourceType}/${refId}: ${message}`);
        return { chunks: rows.length, embedded: false };
      }
    },

    async removeIndex(sourceType, refId) {
      await deleteIndexFor(db, vectors, sourceType, refId);
    },
  };
}
