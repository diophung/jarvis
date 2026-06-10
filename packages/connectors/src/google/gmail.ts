/**
 * Gmail connector hook.
 *
 * Untested-against-live-API hook: request/response structures follow the
 * current public Gmail API v1 docs
 * (https://developers.google.com/gmail/api/reference/rest) but have not been
 * exercised against a live account.
 *
 * Sync strategy:
 *  - list: GET /gmail/v1/users/me/messages with a `q` filter. The first full
 *    sync uses a relative `newer_than:` window; incremental syncs derive a
 *    precise `after:<epoch seconds>` filter from the persisted internalDate
 *    cursor (Gmail's `newer_than:` only supports coarse relative windows).
 *  - per message: GET .../messages/{id}?format=metadata (+ snippet).
 *
 * Write side (only via the approval flow): `send_email` builds an RFC 822
 * message, base64url-encodes it, and POSTs to /users/me/messages/send.
 */
import type { RawSourceItem } from '@donna/core';
import type {
  Connector,
  ConnectorAction,
  ConnectorActionResult,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorHealth,
  SyncPage,
  SyncRequest,
} from '../types.js';
import { GoogleAuth, GOOGLE_REQUIRED_ENV, missingGoogleEnv } from './google-auth.js';
import { parseEmailAddress, parseEmailAddressList, parseJsonCursor } from '../util/parse.js';

export const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1';

/** Default lookback window for the first full sync (overridable via settings.gmailQuery). */
const DEFAULT_FULL_SYNC_QUERY = 'newer_than:30d -in:spam -in:trash';
const DEFAULT_LIMIT = 50;

interface GmailCursor extends Record<string, unknown> {
  /** Mid-run page token. */
  pageToken?: string;
  /** internalDate (epoch ms) lower bound for incremental syncs. */
  sinceMs?: number;
  /** Highest internalDate seen so far in this run. */
  maxSeenMs?: number;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: GmailHeader[] };
}

export class GmailConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'gmail',
    category: 'email',
    label: 'Gmail',
    description:
      'Google Workspace / Gmail mailbox via the Gmail API (OAuth refresh-token flow).',
    capabilities: ['read', 'list', 'search', 'send'],
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
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
      const res = await fetch(`${GMAIL_BASE_URL}/users/me/profile`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, message: `Gmail profile check failed: HTTP ${res.status}` };
      const profile = (await res.json()) as { emailAddress?: string };
      return { ok: true, message: `Gmail reachable as ${profile.emailAddress ?? 'unknown'}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Gmail health check failed' };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const token = await this.auth.getAccessToken(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;
    const cursor = parseJsonCursor<GmailCursor>(req.cursor) ?? {};

    const params = new URLSearchParams({ maxResults: String(limit) });
    const sinceMs = req.mode === 'incremental' ? cursor.sinceMs : undefined;
    if (typeof sinceMs === 'number' && sinceMs > 0) {
      params.set('q', `after:${Math.floor(sinceMs / 1000)}`);
    } else {
      const settingsQuery = ctx.settings['gmailQuery'];
      params.set(
        'q',
        typeof settingsQuery === 'string' && settingsQuery ? settingsQuery : DEFAULT_FULL_SYNC_QUERY,
      );
    }
    if (typeof cursor.pageToken === 'string' && cursor.pageToken) {
      params.set('pageToken', cursor.pageToken);
    }

    const listRes = await fetch(`${GMAIL_BASE_URL}/users/me/messages?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) throw new Error(`Gmail list failed: HTTP ${listRes.status}`);
    const list = (await listRes.json()) as {
      messages?: Array<{ id?: string }>;
      nextPageToken?: string;
    };

    const items: RawSourceItem[] = [];
    let maxSeenMs = cursor.maxSeenMs ?? sinceMs ?? 0;
    for (const entry of list.messages ?? []) {
      if (!entry.id) continue;
      const msg = await this.fetchMessage(token, entry.id);
      if (!msg) continue;
      const item = mapGmailMessage(msg);
      if (item) {
        items.push(item);
        const ts = Number(msg.internalDate ?? 0);
        if (Number.isFinite(ts) && ts > maxSeenMs) maxSeenMs = ts;
      }
    }

    const done = !list.nextPageToken;
    const nextCursor: GmailCursor = done
      ? { sinceMs: maxSeenMs > 0 ? maxSeenMs : undefined }
      : { pageToken: list.nextPageToken, sinceMs, maxSeenMs };
    return { items, nextCursor: JSON.stringify(nextCursor), done };
  }

  async fetchItem(ctx: ConnectorContext, externalId: string): Promise<RawSourceItem | null> {
    const token = await this.auth.getAccessToken(ctx);
    const msg = await this.fetchMessage(token, externalId);
    return msg ? mapGmailMessage(msg) : null;
  }

  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    if (action.type !== 'send_email') {
      return { ok: false, detail: `gmail does not support action '${action.type}'` };
    }
    const to = typeof action.params['to'] === 'string' ? action.params['to'] : '';
    const subject = typeof action.params['subject'] === 'string' ? action.params['subject'] : '';
    const body = typeof action.params['body'] === 'string' ? action.params['body'] : '';
    if (!to || !subject) {
      return { ok: false, detail: "send_email requires 'to' and 'subject' params" };
    }
    try {
      const token = await this.auth.getAccessToken(ctx);
      const rfc822 = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        body,
      ].join('\r\n');
      const raw = Buffer.from(rfc822, 'utf8').toString('base64url');
      const res = await fetch(`${GMAIL_BASE_URL}/users/me/messages/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (!res.ok) return { ok: false, detail: `Gmail send failed: HTTP ${res.status}` };
      const sent = (await res.json()) as { id?: string };
      return { ok: true, externalRef: sent.id, detail: `Email sent to ${to}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Gmail send failed' };
    }
  }

  private async fetchMessage(token: string, id: string): Promise<GmailMessage | null> {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const header of ['Subject', 'From', 'To', 'Cc', 'Date']) {
      params.append('metadataHeaders', header);
    }
    const res = await fetch(
      `${GMAIL_BASE_URL}/users/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`Gmail message fetch failed: HTTP ${res.status}`);
    }
    return (await res.json()) as GmailMessage;
  }
}

/** Map a Gmail metadata-format message to Donna's RawSourceItem. */
export function mapGmailMessage(msg: GmailMessage): RawSourceItem | null {
  if (!msg.id) return null;
  const header = (name: string): string | undefined =>
    msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;

  const internalMs = Number(msg.internalDate ?? NaN);
  const timestamp = Number.isFinite(internalMs)
    ? new Date(internalMs).toISOString()
    : new Date(0).toISOString();

  const from = header('From');
  const to = header('To');
  const cc = header('Cc');
  const participants = [
    ...(to ? parseEmailAddressList(to) : []),
    ...(cc ? parseEmailAddressList(cc) : []),
  ];

  const item: RawSourceItem = {
    externalId: msg.id,
    category: 'email',
    title: header('Subject') ?? '(no subject)',
    timestamp,
    url: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
    labels: msg.labelIds ?? [],
    isRead: !(msg.labelIds ?? []).includes('UNREAD'),
    raw: { provider: 'gmail', internalDate: msg.internalDate ?? null },
  };
  if (msg.snippet) {
    item.snippet = msg.snippet;
    // format=metadata carries no body; the snippet is the best text available.
    item.bodyText = msg.snippet;
  }
  if (from) item.sender = parseEmailAddress(from);
  if (participants.length > 0) item.participants = participants;
  if (msg.threadId) item.threadExternalId = msg.threadId;
  return item;
}
