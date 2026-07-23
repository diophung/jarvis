/**
 * Google Drive connector hook (read-only metadata listing).
 *
 * Untested-against-live-API hook: request/response structures follow the
 * current public Drive API v3 docs
 * (https://developers.google.com/drive/api/reference/rest/v3/files/list) but
 * have not been exercised against a live account.
 *
 * Sync strategy: files.list ordered by modifiedTime; incremental syncs filter
 * with `modifiedTime > '<cursor>'` using the persisted max modifiedTime.
 */
import type { RawSourceItem } from '@jarvis/core';
import type {
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorHealth,
  SyncPage,
  SyncRequest,
} from '../types.js';
import { GoogleAuth, GOOGLE_REQUIRED_ENV, missingGoogleEnv } from './google-auth.js';
import { parseJsonCursor } from '../util/parse.js';
import { httpErrorDetail } from '../util/parse.js';

export const GOOGLE_DRIVE_BASE_URL = 'https://www.googleapis.com/drive/v3';

const DEFAULT_LIMIT = 50;
const FILE_FIELDS =
  'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,description,owners(displayName,emailAddress))';

interface GoogleDriveCursor extends Record<string, unknown> {
  pageToken?: string;
  /** ISO modifiedTime lower bound for incremental syncs. */
  sinceIso?: string;
  maxModified?: string;
}

interface GoogleDriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  description?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

export class GoogleDriveConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'google-drive',
    category: 'storage',
    label: 'Google Drive',
    description: 'Google Drive file metadata via the Drive API (OAuth refresh-token flow).',
    capabilities: ['read', 'list', 'search'],
    scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
    requiredEnv: [...GOOGLE_REQUIRED_ENV],
    local: false,
  };

  constructor(private readonly auth: GoogleAuth = new GoogleAuth()) {}

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const missing = missingGoogleEnv(ctx);
    if (missing.length > 0) {
      return { ok: false, message: `not configured: missing env ${missing.join(', ')}` };
    }
    try {
      const token = await this.auth.getAccessToken(ctx);
      const res = await fetch(`${GOOGLE_DRIVE_BASE_URL}/about?fields=user(emailAddress)`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, message: `Google Drive check failed: ${await httpErrorDetail(res)}` };
      const about = (await res.json()) as { user?: { emailAddress?: string } };
      return {
        ok: true,
        message: `Google Drive reachable as ${about.user?.emailAddress ?? 'unknown'}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Google Drive health check failed',
      };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const token = await this.auth.getAccessToken(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;
    const cursor = parseJsonCursor<GoogleDriveCursor>(req.cursor) ?? {};

    // Drive pageTokens are bound to the exact original query and expire;
    // a stale one returns HTTP 400. Self-heal by retrying without the token,
    // falling back to a modifiedTime floor so the sync continues from where
    // the data left off instead of failing forever.
    const sinceFloor =
      req.mode === 'incremental' ? (cursor.sinceIso ?? cursor.maxModified) : undefined;

    const listPage = async (opts: { pageToken?: string; sinceIso?: string }) => {
      const qParts = ['trashed = false'];
      if (typeof opts.sinceIso === 'string' && opts.sinceIso) {
        qParts.push(`modifiedTime > '${opts.sinceIso}'`);
      }
      const params = new URLSearchParams({
        pageSize: String(limit),
        // Newest first: when a large Drive hits the page cap, keep the files
        // that matter to an assistant (recent ones), not decade-old archives.
        orderBy: 'modifiedTime desc',
        q: qParts.join(' and '),
        fields: FILE_FIELDS,
      });
      if (typeof opts.pageToken === 'string' && opts.pageToken) {
        params.set('pageToken', opts.pageToken);
      }
      return fetch(`${GOOGLE_DRIVE_BASE_URL}/files?${params.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    };

    const sinceIso = sinceFloor;
    let res = await listPage({ pageToken: cursor.pageToken, sinceIso });
    if (res.status === 400 && cursor.pageToken) {
      ctx.logger.warn('google-drive: stale pageToken rejected; restarting from modifiedTime floor');
      res = await listPage({ sinceIso });
    }
    if (!res.ok) throw new Error(`Google Drive list failed: ${await httpErrorDetail(res)}`);
    const json = (await res.json()) as { files?: GoogleDriveFile[]; nextPageToken?: string };

    const items: RawSourceItem[] = [];
    let maxModified = cursor.maxModified ?? sinceIso ?? '';
    for (const file of json.files ?? []) {
      const item = mapGoogleDriveFile(file);
      if (item) {
        items.push(item);
        if (file.modifiedTime && file.modifiedTime > maxModified) maxModified = file.modifiedTime;
      }
    }

    const done = !json.nextPageToken;
    const nextCursor: GoogleDriveCursor = done
      ? { sinceIso: maxModified || undefined }
      : { pageToken: json.nextPageToken, sinceIso, maxModified };
    return { items, nextCursor: JSON.stringify(nextCursor), done };
  }
}

/** Map a Drive API file resource to Jarvis's RawSourceItem. */
export function mapGoogleDriveFile(file: GoogleDriveFile): RawSourceItem | null {
  if (!file.id || !file.name) return null;
  const item: RawSourceItem = {
    externalId: file.id,
    category: 'storage',
    title: file.name,
    timestamp: file.modifiedTime
      ? new Date(file.modifiedTime).toISOString()
      : new Date(0).toISOString(),
    raw: {
      provider: 'google-drive',
      mimeType: file.mimeType ?? null,
      sizeBytes: file.size !== undefined ? Number(file.size) : null,
    },
  };
  if (file.webViewLink) item.url = file.webViewLink;
  if (file.description) item.bodyText = file.description;
  const owner = file.owners?.[0];
  if (owner) {
    item.sender = {
      ...(owner.displayName ? { name: owner.displayName } : {}),
      ...(owner.emailAddress ? { email: owner.emailAddress } : {}),
    };
  }
  return item;
}
