/**
 * VectorStore: the semantic-memory retrieval backend behind one interface.
 *
 * Adapters:
 *  - sql_scan (default): vectors as JSON in embedding_records; cosine
 *    computed in-process over the newest N candidates. Correct everywhere
 *    (SQLite + Postgres), fine for personal/small corpora, O(corpus) per
 *    query.
 *  - pgvector: vectors additionally stored in an `embedding_vectors` table
 *    with a pgvector column; similarity ranked **in the database** with the
 *    cosine-distance operator. Activated by feature detection when the
 *    pgvector extension is available. embedding_records remains the system
 *    of record (export/deletion sweep it), so falling back to sql_scan is
 *    always safe.
 *
 * Other engines (Qdrant, OpenSearch vector, Pinecone) plug in as adapters —
 * nothing outside this file knows which backend ranks vectors.
 */
import { fromJson, newId, nowIso, toJson } from '@donna/core';
import { getDbRuntime, sql, type Db } from '@donna/db';
import type { VectorSearchHit, VectorStore, VectorUpsertRecord } from '../context.js';
import { cosineSimilarity } from './retrieval.js';

const SCAN_CANDIDATE_LIMIT = 2000;
const INSERT_BATCH = 50;
const DELETE_BATCH = 500;

async function insertEmbeddingRecords(
  db: Db,
  workspaceId: string,
  records: VectorUpsertRecord[],
): Promise<void> {
  const now = nowIso();
  const rows = records.map((r) => ({
    id: newId('emb'),
    workspaceId,
    chunkId: r.chunkId,
    providerConfigId: r.providerConfigId,
    model: r.model,
    dims: r.vector.length,
    vector: toJson(r.vector),
    createdAt: now,
  }));
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await db
      .insertInto('embeddingRecords')
      .values(rows.slice(i, i + INSERT_BATCH))
      .execute();
  }
}

/** Default adapter: JSON vectors + in-process cosine over recent candidates. */
export function createSqlScanVectorStore(deps: { db: Db }): VectorStore {
  const { db } = deps;

  return {
    kind: 'sql_scan',

    async upsert(workspaceId, records) {
      if (records.length === 0) return;
      await insertEmbeddingRecords(db, workspaceId, records);
    },

    async search(workspaceId, model, queryVector, opts = {}) {
      const limit = opts.limit ?? 20;
      const minCosine = opts.minCosine ?? 0;
      let q = db
        .selectFrom('embeddingRecords')
        .innerJoin('retrievalChunks', 'retrievalChunks.id', 'embeddingRecords.chunkId')
        .select([
          'retrievalChunks.id as chunkId',
          'retrievalChunks.sourceType as sourceType',
          'retrievalChunks.refId as refId',
          'retrievalChunks.text as text',
          'retrievalChunks.metadata as metadata',
          'retrievalChunks.createdAt as createdAt',
          'embeddingRecords.vector as vector',
        ])
        .where('embeddingRecords.workspaceId', '=', workspaceId)
        // Only vectors from the active embedding model are comparable;
        // mixed-model (mixed-dims) records would corrupt similarity.
        .where('embeddingRecords.model', '=', model);
      if (opts.sourceTypes !== undefined && opts.sourceTypes.length > 0) {
        q = q.where('retrievalChunks.sourceType', 'in', opts.sourceTypes);
      }
      const rows = await q
        .orderBy('embeddingRecords.createdAt', 'desc')
        .limit(SCAN_CANDIDATE_LIMIT)
        .execute();

      const hits: VectorSearchHit[] = [];
      for (const row of rows) {
        const cosine = cosineSimilarity(queryVector, fromJson<number[]>(row.vector, []));
        if (cosine <= minCosine) continue;
        hits.push({
          chunkId: row.chunkId,
          cosine,
          sourceType: row.sourceType,
          refId: row.refId,
          text: row.text,
          metadata: row.metadata,
          createdAt: row.createdAt,
        });
      }
      hits.sort((a, b) => b.cosine - a.cosine || b.createdAt.localeCompare(a.createdAt));
      return hits.slice(0, limit);
    },

    async removeByChunkIds(chunkIds) {
      for (let i = 0; i < chunkIds.length; i += DELETE_BATCH) {
        const batch = chunkIds.slice(i, i + DELETE_BATCH);
        await db.deleteFrom('embeddingRecords').where('chunkId', 'in', batch).execute();
      }
    },
  };
}

/**
 * pgvector adapter: in-database cosine ranking. The `<=>` operator returns
 * cosine distance; similarity = 1 − distance. Works without an index
 * (exact scan, still no JSON transfer/parse); for large corpora add the HNSW
 * index documented in docs/production-database.md.
 */
export function createPgVectorStore(deps: { db: Db }): VectorStore {
  const { db } = deps;

  return {
    kind: 'pgvector',

    async upsert(workspaceId, records) {
      if (records.length === 0) return;
      // Dual write: embedding_records stays the system of record.
      await insertEmbeddingRecords(db, workspaceId, records);
      const now = nowIso();
      for (let i = 0; i < records.length; i += INSERT_BATCH) {
        for (const r of records.slice(i, i + INSERT_BATCH)) {
          const literal = `[${r.vector.join(',')}]`;
          await sql`
            insert into embedding_vectors (chunk_id, workspace_id, model, dims, embedding, created_at)
            values (${r.chunkId}, ${workspaceId}, ${r.model}, ${r.vector.length}, ${literal}::vector, ${now})
            on conflict (chunk_id) do update set
              model = excluded.model, dims = excluded.dims,
              embedding = excluded.embedding, created_at = excluded.created_at
          `.execute(db);
        }
      }
    },

    async search(workspaceId, model, queryVector, opts = {}) {
      const limit = opts.limit ?? 20;
      const minCosine = opts.minCosine ?? 0;
      const literal = `[${queryVector.join(',')}]`;
      const sourceTypes = opts.sourceTypes ?? [];
      const typeFilter =
        sourceTypes.length > 0
          ? sql`and rc.source_type in (${sql.join(sourceTypes.map((t) => sql`${t}`))})`
          : sql``;
      const rows = await sql<{
        chunk_id: string;
        cosine: number;
        source_type: string;
        ref_id: string;
        text: string;
        metadata: string;
        created_at: string;
      }>`
        select rc.id as chunk_id,
               1 - (ev.embedding <=> ${literal}::vector) as cosine,
               rc.source_type, rc.ref_id, rc.text, rc.metadata, rc.created_at
        from embedding_vectors ev
        join retrieval_chunks rc on rc.id = ev.chunk_id
        where ev.workspace_id = ${workspaceId}
          and ev.model = ${model}
          and ev.dims = ${queryVector.length}
          ${typeFilter}
        order by ev.embedding <=> ${literal}::vector
        limit ${limit * 2}
      `.execute(db);

      return rows.rows
        .map(
          (r): VectorSearchHit => ({
            chunkId: r.chunk_id,
            cosine: Number(r.cosine),
            sourceType: r.source_type,
            refId: r.ref_id,
            text: r.text,
            metadata: r.metadata,
            createdAt: r.created_at,
          }),
        )
        .filter((h) => h.cosine > minCosine)
        .slice(0, limit);
    },

    async removeByChunkIds(chunkIds) {
      for (let i = 0; i < chunkIds.length; i += DELETE_BATCH) {
        const batch = chunkIds.slice(i, i + DELETE_BATCH);
        await db.deleteFrom('embeddingRecords').where('chunkId', 'in', batch).execute();
        await sql`delete from embedding_vectors where chunk_id in (${sql.join(
          batch.map((id) => sql`${id}`),
        )})`.execute(db);
      }
    },
  };
}

/**
 * Pick the strongest available adapter: pgvector on Postgres when the
 * extension can be enabled (creating the side table on first use), else the
 * portable SQL scan. Never throws — vector search must not block boot.
 */
export async function createVectorStore(deps: { db: Db }): Promise<VectorStore> {
  const { db } = deps;
  if (getDbRuntime(db).dialect !== 'postgres') return createSqlScanVectorStore(deps);
  try {
    await sql`create extension if not exists vector`.execute(db).catch(() => {
      // Extension may already exist or require privileges; detection below decides.
    });
    const ext = await sql<{ ok: number }>`
      select 1 as ok from pg_extension where extname = 'vector'
    `.execute(db);
    if (ext.rows.length === 0) return createSqlScanVectorStore(deps);
    await sql`
      create table if not exists embedding_vectors (
        chunk_id text primary key,
        workspace_id text not null,
        model text not null,
        dims integer not null,
        embedding vector not null,
        created_at text not null
      )
    `.execute(db);
    await sql`
      create index if not exists idx_embedding_vectors_ws_model
      on embedding_vectors (workspace_id, model)
    `.execute(db);
    return createPgVectorStore(deps);
  } catch (err) {
    console.warn(
      `[vector] pgvector unavailable, using SQL scan adapter: ${err instanceof Error ? err.message : String(err)}`,
    );
    return createSqlScanVectorStore(deps);
  }
}
