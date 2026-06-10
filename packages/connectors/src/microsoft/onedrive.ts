/**
 * OneDrive (Graph) connector hook — file metadata via the drive delta API.
 *
 * Untested-against-live-API hook: request/response structures follow the
 * current public Microsoft Graph v1.0 docs
 * (https://learn.microsoft.com/graph/api/driveitem-delta) but have not been
 * exercised against a live tenant.
 *
 * Sync strategy: GET /v1.0/me/drive/root/delta. Graph returns
 * @odata.nextLink while paging and @odata.deltaLink when the snapshot is
 * complete; the persisted cursor is whichever link Graph hands back, so
 * incremental syncs resume exactly where the last run finished.
 */
import type { RawSourceItem } from '@donna/core';
import type {
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorHealth,
  SyncPage,
  SyncRequest,
} from '../types.js';
import { GRAPH_BASE_URL, MicrosoftAuth, MS_REQUIRED_ENV, missingMsEnv } from './ms-auth.js';
import { httpErrorDetail } from '../util/parse.js';

const DEFAULT_LIMIT = 50;

interface GraphDriveItem {
  id?: string;
  name?: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { path?: string };
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
}

export class OneDriveConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'onedrive',
    category: 'storage',
    label: 'OneDrive',
    description: 'OneDrive file metadata via the Microsoft Graph delta API (read-only).',
    capabilities: ['read', 'list', 'search'],
    scopes: ['Files.Read'],
    requiredEnv: [...MS_REQUIRED_ENV],
    local: false,
  };

  constructor(private readonly auth: MicrosoftAuth = new MicrosoftAuth()) {}

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const missing = missingMsEnv(ctx);
    if (missing.length > 0) {
      return { ok: false, message: `not configured: missing env ${missing.join(', ')}` };
    }
    try {
      const token = await this.auth.getAccessToken(ctx);
      const res = await fetch(`${GRAPH_BASE_URL}/me/drive?$select=id,driveType`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, message: `OneDrive check failed: ${await httpErrorDetail(res)}` };
      return { ok: true, message: 'OneDrive reachable' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'OneDrive health check failed',
      };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const token = await this.auth.getAccessToken(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;

    // The cursor IS the Graph-issued nextLink/deltaLink (opaque URL).
    const url =
      req.cursor && req.cursor.startsWith('https://')
        ? req.cursor
        : `${GRAPH_BASE_URL}/me/drive/root/delta?$top=${limit}`;

    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`OneDrive delta failed: ${await httpErrorDetail(res)}`);
    const json = (await res.json()) as {
      value?: GraphDriveItem[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };

    const items: RawSourceItem[] = [];
    for (const entry of json.value ?? []) {
      const item = mapOneDriveItem(entry);
      if (item) items.push(item);
    }

    const nextLink = json['@odata.nextLink'];
    const deltaLink = json['@odata.deltaLink'];
    const done = !nextLink;
    return { items, nextCursor: nextLink ?? deltaLink ?? null, done };
  }
}

/** Map a Graph driveItem (files only) to Donna's RawSourceItem. */
export function mapOneDriveItem(entry: GraphDriveItem): RawSourceItem | null {
  if (!entry.id || !entry.name) return null;
  // Skip folders and deletions — Donna ingests file metadata only.
  if (entry.folder !== undefined || entry.deleted !== undefined || entry.file === undefined) {
    return null;
  }

  const item: RawSourceItem = {
    externalId: entry.id,
    category: 'storage',
    title: entry.name,
    timestamp: entry.lastModifiedDateTime
      ? new Date(entry.lastModifiedDateTime).toISOString()
      : new Date(0).toISOString(),
    raw: {
      provider: 'onedrive',
      mimeType: entry.file.mimeType ?? null,
      sizeBytes: entry.size ?? null,
      path: entry.parentReference?.path ?? null,
    },
  };
  if (entry.webUrl) item.url = entry.webUrl;
  const modifier = entry.lastModifiedBy?.user;
  if (modifier) {
    item.sender = {
      ...(modifier.displayName ? { name: modifier.displayName } : {}),
      ...(modifier.email ? { email: modifier.email } : {}),
    };
  }
  return item;
}
