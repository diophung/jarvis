import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fromJson } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import type { LlmRouterService, UploadsService } from '../context.js';
import { createAuditService } from './audit.js';
import { createIndexingService } from './indexing.js';
import { createSqlScanVectorStore } from './vector-store.js';
import { createStorageService } from './storage.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createUploadsService, stripHtml } from './uploads.js';

let dir: string;
let config: AppConfig;
let db: Db;
let workspaceId: string;
let userId: string;
let uploads: UploadsService;

const nullEmbeddingRouter = {
  embeddingClient: async () => null,
} as unknown as LlmRouterService;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jarvis-uploads-'));
  config = loadConfig({ JARVIS_DATA_DIR: dir, JARVIS_STORAGE_DRIVER: 'local' });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const storage = createStorageService({ config });
  const indexing = createIndexingService({ db, llm: nullEmbeddingRouter, vectors: createSqlScanVectorStore({ db }) });
  uploads = createUploadsService({ db, storage, indexing, audit });
});

describe('stripHtml', () => {
  it('removes tags/scripts and decodes common entities', () => {
    const html =
      '<html><head><style>.x{}</style><script>alert(1)</script></head>' +
      '<body><h1>Plan</h1><p>Ship&nbsp;the &amp; retrieval layer</p></body></html>';
    const text = stripHtml(html);
    expect(text).toContain('Plan');
    expect(text).toContain('Ship the & retrieval layer');
    expect(text).not.toContain('<');
    expect(text).not.toContain('alert');
  });
});

describe('uploads service', () => {
  it('handles a .txt upload end-to-end (row, source item, chunks, text, files on disk)', async () => {
    const content = 'Quarterly planning notes: the budget review happens Thursday.';
    const data = Buffer.from(content, 'utf8');
    const file = await uploads.handleUpload(workspaceId, userId, {
      filename: 'notes.txt',
      mimeType: 'text/plain',
      data,
    });

    expect(file.status).toBe('ready');
    expect(file.textExtracted).toBe(1);
    expect(file.extractionError).toBeNull();
    expect(file.filename).toBe('notes.txt');
    expect(file.sizeBytes).toBe(data.length);
    expect(file.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(file.accountId).not.toBeNull();
    expect(file.sourceItemId).not.toBeNull();
    await expect(stat(file.storagePath)).resolves.toBeDefined();

    // Singleton upload source account.
    const account = await db
      .selectFrom('sourceAccounts')
      .selectAll()
      .where('id', '=', file.accountId ?? '')
      .executeTakeFirst();
    expect(account?.provider).toBe('upload');
    expect(account?.category).toBe('upload');
    expect(account?.displayName).toBe('Uploaded Files');
    expect(account?.status).toBe('connected');

    // Normalized source item.
    const item = await db
      .selectFrom('sourceItems')
      .selectAll()
      .where('id', '=', file.sourceItemId ?? '')
      .executeTakeFirst();
    expect(item?.provider).toBe('upload');
    expect(item?.category).toBe('upload');
    expect(item?.title).toBe('notes.txt');
    expect(item?.externalId).toBe(file.id);
    expect(item?.bodyText).toContain('budget review');
    expect(fromJson<Record<string, unknown>>(item?.provenance ?? '{}', {})).toEqual({
      uploadedFileId: file.id,
    });

    // Indexed chunks.
    const chunks = await db
      .selectFrom('retrievalChunks')
      .selectAll()
      .where('sourceType', '=', 'uploaded_file')
      .where('refId', '=', file.id)
      .execute();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.metadata).toContain('Uploaded file');

    // getText via the source item.
    const text = await uploads.getText(workspaceId, file.id);
    expect(text).toContain('budget review');

    // Audited.
    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'file.uploaded')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(file.id);
  });

  it('handles a .md upload and reuses the singleton upload account', async () => {
    const first = await uploads.handleUpload(workspaceId, userId, {
      filename: 'a.txt',
      mimeType: 'text/plain',
      data: Buffer.from('first file body text'),
    });
    const md = await uploads.handleUpload(workspaceId, userId, {
      filename: 'plan.md',
      mimeType: null,
      data: Buffer.from('# Plan\n\nShip the retrieval layer this sprint.'),
    });

    expect(md.status).toBe('ready');
    expect(md.textExtracted).toBe(1);
    expect(md.accountId).toBe(first.accountId);
    expect(await uploads.getText(workspaceId, md.id)).toContain('Ship the retrieval layer');

    const accounts = await db
      .selectFrom('sourceAccounts')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('provider', '=', 'upload')
      .execute();
    expect(accounts).toHaveLength(1);

    const list = await uploads.list(workspaceId);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((f) => f.id))).toEqual(new Set([first.id, md.id]));
  });

  it('marks unknown binary formats ready with no text and no extraction error', async () => {
    const file = await uploads.handleUpload(workspaceId, userId, {
      filename: 'blob.bin',
      mimeType: 'application/octet-stream',
      data: Buffer.from([0x00, 0x01, 0x02, 0xff]),
    });
    expect(file.status).toBe('ready');
    expect(file.textExtracted).toBe(0);
    expect(file.extractionError).toBeNull();
    expect(file.sourceItemId).not.toBeNull();
    expect(await uploads.getText(workspaceId, file.id)).toBeNull();
    const chunks = await db
      .selectFrom('retrievalChunks')
      .select('id')
      .where('refId', '=', file.id)
      .execute();
    expect(chunks).toHaveLength(0);
  });

  it('records parse failures as status error without throwing', async () => {
    const file = await uploads.handleUpload(workspaceId, userId, {
      filename: 'broken.docx',
      mimeType: null,
      data: Buffer.from('this is not a real docx archive'),
    });
    expect(file.status).toBe('error');
    expect(file.textExtracted).toBe(0);
    expect(file.extractionError).not.toBeNull();
    expect(file.sourceItemId).toBeNull();
  });

  it('get returns null for unknown ids and other workspaces', async () => {
    const other = await seedWorkspace(db);
    const file = await uploads.handleUpload(workspaceId, userId, {
      filename: 'mine.txt',
      mimeType: 'text/plain',
      data: Buffer.from('private text'),
    });
    expect(await uploads.get(workspaceId, 'upl_missing')).toBeNull();
    expect(await uploads.get(other.workspaceId, file.id)).toBeNull();
    expect(await uploads.getText(other.workspaceId, file.id)).toBeNull();
  });

  it('remove deletes the stored file, chunks, source item, and row — and audits it', async () => {
    const file = await uploads.handleUpload(workspaceId, userId, {
      filename: 'gone.txt',
      mimeType: 'text/plain',
      data: Buffer.from('soon to be deleted budget content'),
    });

    await uploads.remove(workspaceId, file.id);

    expect(await uploads.get(workspaceId, file.id)).toBeNull();
    await expect(stat(file.storagePath)).rejects.toThrow();
    const chunks = await db
      .selectFrom('retrievalChunks')
      .select('id')
      .where('refId', '=', file.id)
      .execute();
    expect(chunks).toHaveLength(0);
    const items = await db
      .selectFrom('sourceItems')
      .select('id')
      .where('id', '=', file.sourceItemId ?? '')
      .execute();
    expect(items).toHaveLength(0);

    const audits = await db
      .selectFrom('auditLogs')
      .selectAll()
      .where('eventType', '=', 'file.deleted')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetId).toBe(file.id);

    // Removing again is a no-op.
    await expect(uploads.remove(workspaceId, file.id)).resolves.toBeUndefined();
  });
});
