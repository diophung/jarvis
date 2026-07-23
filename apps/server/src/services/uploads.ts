/**
 * Uploaded files: store the raw bytes, extract text by format, create a
 * first-class normalized source item (provider 'upload'), and index the text
 * for retrieval. Parse failures mark the row 'error' but never throw out of
 * handleUpload; storage failures may throw.
 */
import { newId, normalizeRawItem, nowIso, toJson, type UploadedFile } from '@jarvis/core';
import type { Db, UploadedFilesTable } from '@jarvis/db';
import mammoth from 'mammoth';
import type {
  AuditService,
  IndexingService,
  StorageService,
  UploadsService,
} from '../context.js';

const UPLOAD_PROVIDER = 'upload';
const MAX_ERROR_LENGTH = 500;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json']);

function toEntity(row: UploadedFilesTable): UploadedFile {
  return { ...row, status: row.status as UploadedFile['status'] };
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Crude tag-stripping for HTML uploads — good enough for indexing/search. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Extract text by extension/mime. Returns null for formats we cannot extract
 * (not an error). Throws only on real parse failures.
 */
async function extractText(
  filename: string,
  mimeType: string | null,
  data: Buffer,
): Promise<string | null> {
  const ext = extOf(filename);
  const mime = (mimeType ?? '').toLowerCase();

  if (ext === 'pdf' || mime === 'application/pdf') {
    // Import the inner module directly: the package root runs debug-mode code
    // on import, and its type declarations do not cover this subpath.
    const pdfModule = (await import('pdf-parse/lib/pdf-parse.js' as string)) as {
      default: (data: Buffer) => Promise<{ text: string }>;
    };
    const parsed = await pdfModule.default(data);
    return parsed.text;
  }
  if (ext === 'docx' || mime.includes('officedocument.wordprocessingml')) {
    const result = await mammoth.extractRawText({ buffer: data });
    return result.value;
  }
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') {
    return stripHtml(data.toString('utf8'));
  }
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
    return data.toString('utf8');
  }
  return null;
}

async function getRow(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<UploadedFilesTable | undefined> {
  return db
    .selectFrom('uploadedFiles')
    .selectAll()
    .where('workspaceId', '=', workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
}

async function mustGet(db: Db, workspaceId: string, id: string): Promise<UploadedFile> {
  const row = await getRow(db, workspaceId, id);
  if (row === undefined) throw new Error(`Uploaded file ${id} disappeared mid-operation`);
  return toEntity(row);
}

/** Ensure the singleton 'Uploaded Files' source account for a workspace. */
async function ensureUploadAccount(db: Db, workspaceId: string, userId: string): Promise<string> {
  const existing = await db
    .selectFrom('sourceAccounts')
    .select('id')
    .where('workspaceId', '=', workspaceId)
    .where('provider', '=', UPLOAD_PROVIDER)
    .executeTakeFirst();
  if (existing !== undefined) return existing.id;
  const now = nowIso();
  const id = newId('acc');
  await db
    .insertInto('sourceAccounts')
    .values({
      id,
      workspaceId,
      userId,
      provider: UPLOAD_PROVIDER,
      category: 'upload',
      displayName: 'Uploaded Files',
      status: 'connected',
      authRef: null,
      scopes: toJson([]),
      capabilities: toJson(['read', 'list', 'search', 'upload']),
      settings: toJson({}),
      lastSyncAt: null,
      syncCursor: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

export function createUploadsService(deps: {
  db: Db;
  storage: StorageService;
  indexing: IndexingService;
  audit: AuditService;
}): UploadsService {
  const { db, storage, indexing, audit } = deps;

  return {
    async handleUpload(workspaceId, userId, file) {
      const accountId = await ensureUploadAccount(db, workspaceId, userId);
      const saved = await storage.save(workspaceId, file.filename, file.data);

      const id = newId('upl');
      const now = nowIso();
      await db
        .insertInto('uploadedFiles')
        .values({
          id,
          workspaceId,
          userId,
          accountId,
          sourceItemId: null,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: saved.sizeBytes,
          storagePath: saved.storagePath,
          textExtracted: 0,
          extractionError: null,
          status: 'processing',
          sha256: saved.sha256,
          createdAt: now,
          updatedAt: now,
        })
        .execute();

      let text: string | null = null;
      try {
        text = await extractText(file.filename, file.mimeType, file.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
          .updateTable('uploadedFiles')
          .set({
            status: 'error',
            extractionError: message.slice(0, MAX_ERROR_LENGTH),
            textExtracted: 0,
            updatedAt: nowIso(),
          })
          .where('id', '=', id)
          .execute();
        await audit.log({
          workspaceId,
          userId,
          eventType: 'file.uploaded',
          actor: 'user',
          targetType: 'uploaded_file',
          targetId: id,
          summary: `Uploaded ${file.filename} (text extraction failed)`,
          metadata: { sizeBytes: saved.sizeBytes, mimeType: file.mimeType, status: 'error' },
        });
        return mustGet(db, workspaceId, id);
      }

      // Uploaded files are first-class sources: create the normalized item.
      const normalized = normalizeRawItem({
        externalId: id,
        category: 'upload',
        title: file.filename,
        bodyText: text ?? undefined,
        timestamp: now,
      });
      const sourceItemId = newId('itm');
      await db
        .insertInto('sourceItems')
        .values({
          id: sourceItemId,
          workspaceId,
          accountId,
          provider: UPLOAD_PROVIDER,
          category: normalized.category,
          externalId: normalized.externalId,
          dedupeKey: normalized.dedupeKey,
          title: normalized.title,
          bodyText: normalized.bodyText,
          snippet: normalized.snippet,
          sender: normalized.sender === null ? null : toJson(normalized.sender),
          participants: toJson(normalized.participants),
          itemTimestamp: normalized.itemTimestamp,
          dueAt: normalized.dueAt,
          startsAt: normalized.startsAt,
          endsAt: normalized.endsAt,
          url: normalized.url,
          threadExternalId: normalized.threadExternalId,
          projectIds: toJson([]),
          peopleIds: toJson([]),
          labels: toJson(normalized.labels),
          rawMetadata: toJson(normalized.rawMetadata),
          provenance: toJson({ uploadedFileId: id }),
          isRead: normalized.isRead,
          contentHash: normalized.contentHash,
          createdAt: now,
          updatedAt: now,
        })
        .execute();

      await indexing.indexText(workspaceId, 'uploaded_file', id, text ?? '', {
        title: file.filename,
        sourceLabel: 'Uploaded file',
        category: 'upload',
      });

      const hasText = text !== null && text.trim() !== '';
      await db
        .updateTable('uploadedFiles')
        .set({
          sourceItemId,
          textExtracted: hasText ? 1 : 0,
          status: 'ready',
          updatedAt: nowIso(),
        })
        .where('id', '=', id)
        .execute();

      await audit.log({
        workspaceId,
        userId,
        eventType: 'file.uploaded',
        actor: 'user',
        targetType: 'uploaded_file',
        targetId: id,
        summary: `Uploaded ${file.filename}`,
        metadata: {
          sizeBytes: saved.sizeBytes,
          mimeType: file.mimeType,
          textExtracted: hasText,
          status: 'ready',
        },
      });

      return mustGet(db, workspaceId, id);
    },

    async list(workspaceId) {
      const rows = await db
        .selectFrom('uploadedFiles')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .orderBy('createdAt', 'desc')
        .execute();
      return rows.map(toEntity);
    },

    async get(workspaceId, id) {
      const row = await getRow(db, workspaceId, id);
      return row === undefined ? null : toEntity(row);
    },

    async getText(workspaceId, id) {
      const row = await getRow(db, workspaceId, id);
      if (row === undefined) return null;
      let text: string | null = null;
      if (row.sourceItemId !== null) {
        const item = await db
          .selectFrom('sourceItems')
          .select('bodyText')
          .where('id', '=', row.sourceItemId)
          .executeTakeFirst();
        text = item?.bodyText ?? null;
      }
      await audit.log({
        workspaceId,
        userId: row.userId,
        eventType: 'file.access',
        actor: 'user',
        targetType: 'uploaded_file',
        targetId: id,
        summary: `Accessed text of uploaded file ${row.filename}`,
      });
      return text;
    },

    async remove(workspaceId, id) {
      const row = await getRow(db, workspaceId, id);
      if (row === undefined) return;
      await storage.remove(row.storagePath);
      await indexing.removeIndex('uploaded_file', id);
      if (row.sourceItemId !== null) {
        await db.deleteFrom('sourceItems').where('id', '=', row.sourceItemId).execute();
      }
      await db.deleteFrom('uploadedFiles').where('id', '=', id).execute();
      await audit.log({
        workspaceId,
        userId: row.userId,
        eventType: 'file.deleted',
        actor: 'user',
        targetType: 'uploaded_file',
        targetId: id,
        summary: `Deleted uploaded file ${row.filename}`,
        metadata: { filename: row.filename, sizeBytes: row.sizeBytes },
      });
    },
  };
}
