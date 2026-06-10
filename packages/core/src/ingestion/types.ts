/**
 * Ingestion contracts: connectors produce RawSourceItem; the normalization
 * pipeline converts them into SourceItem inserts with dedupe keys, hashes,
 * snippets, and provenance.
 */
import type { PersonRef } from '../entities.js';
import type { SourceCategory } from '../enums.js';

export interface RawAttachment {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Provider-side reference used to fetch the attachment later. */
  externalRef?: string;
}

/** What a connector emits for each item, before normalization. */
export interface RawSourceItem {
  externalId: string;
  category: SourceCategory;
  title: string;
  bodyText?: string;
  snippet?: string;
  sender?: PersonRef;
  participants?: PersonRef[];
  /** ISO timestamp: sent time, modified time, or event start. */
  timestamp: string;
  dueAt?: string;
  startsAt?: string;
  endsAt?: string;
  url?: string;
  threadExternalId?: string;
  labels?: string[];
  attachments?: RawAttachment[];
  raw?: Record<string, unknown>;
  /** Optional provider-supplied hint for cross-source dedupe (e.g. ICS UID, file hash). */
  dedupeHint?: string;
  isRead?: boolean;
}

/** Normalized fields ready to upsert as a SourceItem (ids/timestamps added by caller). */
export interface NormalizedItemInput {
  externalId: string;
  category: SourceCategory;
  title: string;
  bodyText: string | null;
  snippet: string | null;
  sender: PersonRef | null;
  participants: PersonRef[];
  itemTimestamp: string;
  dueAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  url: string | null;
  threadExternalId: string | null;
  labels: string[];
  rawMetadata: Record<string, unknown>;
  dedupeKey: string;
  contentHash: string;
  isRead: number;
  attachments: RawAttachment[];
}

export interface ChunkOptions {
  /** Target chunk size in characters. */
  chunkSize?: number;
  /** Overlap between consecutive chunks in characters. */
  overlap?: number;
}

export interface TextChunk {
  index: number;
  text: string;
}
