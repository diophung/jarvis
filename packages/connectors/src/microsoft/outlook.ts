/**
 * Microsoft Outlook (Graph) connector hook.
 *
 * Untested-against-live-API hook: request/response structures follow the
 * current public Microsoft Graph v1.0 docs
 * (https://learn.microsoft.com/graph/api/user-list-messages) but have not
 * been exercised against a live tenant.
 *
 * Sync strategy:
 *  - full: GET /v1.0/me/messages ordered by receivedDateTime desc; paging via
 *    @odata.nextLink stored in the cursor.
 *  - incremental: `$filter=receivedDateTime gt <cursor ISO>` from the
 *    persisted max receivedDateTime.
 *
 * Write side (approval flow only): `send_email` POSTs to /me/sendMail.
 */
import type { PersonRef, RawSourceItem } from '@donna/core';
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
import { GRAPH_BASE_URL, MicrosoftAuth, MS_REQUIRED_ENV, missingMsEnv } from './ms-auth.js';
import { parseJsonCursor } from '../util/parse.js';

const DEFAULT_LIMIT = 50;
const MESSAGE_SELECT =
  'id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,conversationId,isRead,webLink,hasAttachments,importance';

interface OutlookCursor extends Record<string, unknown> {
  /** Mid-run @odata.nextLink. */
  nextLink?: string;
  /** ISO receivedDateTime lower bound for incremental syncs. */
  sinceIso?: string;
  maxSeenIso?: string;
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  conversationId?: string;
  isRead?: boolean;
  webLink?: string;
  hasAttachments?: boolean;
  importance?: string;
}

export class OutlookConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'outlook',
    category: 'email',
    label: 'Microsoft Outlook',
    description: 'Outlook / Exchange Online mailbox via Microsoft Graph.',
    capabilities: ['read', 'list', 'search', 'send'],
    scopes: ['Mail.Read', 'Mail.Send'],
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
      const res = await fetch(`${GRAPH_BASE_URL}/me?$select=userPrincipalName`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, message: `Outlook check failed: HTTP ${res.status}` };
      const me = (await res.json()) as { userPrincipalName?: string };
      return { ok: true, message: `Outlook reachable as ${me.userPrincipalName ?? 'unknown'}` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Outlook health check failed',
      };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const token = await this.auth.getAccessToken(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;
    const cursor = parseJsonCursor<OutlookCursor>(req.cursor) ?? {};
    const sinceIso = req.mode === 'incremental' ? cursor.sinceIso : undefined;

    let url: string;
    if (typeof cursor.nextLink === 'string' && cursor.nextLink) {
      url = cursor.nextLink;
    } else {
      const params = new URLSearchParams({
        $top: String(limit),
        $select: MESSAGE_SELECT,
      });
      if (typeof sinceIso === 'string' && sinceIso) {
        params.set('$filter', `receivedDateTime gt ${sinceIso}`);
        params.set('$orderby', 'receivedDateTime asc');
      } else {
        params.set('$orderby', 'receivedDateTime desc');
      }
      url = `${GRAPH_BASE_URL}/me/messages?${params.toString()}`;
    }

    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Outlook list failed: HTTP ${res.status}`);
    const json = (await res.json()) as {
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
    };

    const items: RawSourceItem[] = [];
    let maxSeenIso = cursor.maxSeenIso ?? sinceIso ?? '';
    for (const msg of json.value ?? []) {
      const item = mapOutlookMessage(msg);
      if (item) {
        items.push(item);
        if (msg.receivedDateTime && msg.receivedDateTime > maxSeenIso) {
          maxSeenIso = msg.receivedDateTime;
        }
      }
    }

    const nextLink = json['@odata.nextLink'];
    const done = !nextLink;
    const nextCursor: OutlookCursor = done
      ? { sinceIso: maxSeenIso || undefined }
      : { nextLink, sinceIso, maxSeenIso };
    return { items, nextCursor: JSON.stringify(nextCursor), done };
  }

  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    if (action.type !== 'send_email') {
      return { ok: false, detail: `outlook does not support action '${action.type}'` };
    }
    const to = typeof action.params['to'] === 'string' ? action.params['to'] : '';
    const subject = typeof action.params['subject'] === 'string' ? action.params['subject'] : '';
    const body = typeof action.params['body'] === 'string' ? action.params['body'] : '';
    if (!to || !subject) {
      return { ok: false, detail: "send_email requires 'to' and 'subject' params" };
    }
    try {
      const token = await this.auth.getAccessToken(ctx);
      const res = await fetch(`${GRAPH_BASE_URL}/me/sendMail`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: to
              .split(',')
              .map((address) => address.trim())
              .filter((address) => address.length > 0)
              .map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        }),
      });
      // Graph returns 202 Accepted with an empty body on success.
      if (res.status !== 202 && !res.ok) {
        return { ok: false, detail: `Outlook send failed: HTTP ${res.status}` };
      }
      return { ok: true, externalRef: 'graph-sendmail-accepted', detail: `Email sent to ${to}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Outlook send failed' };
    }
  }
}

/** Map a Graph message resource to Donna's RawSourceItem. */
export function mapOutlookMessage(msg: GraphMessage): RawSourceItem | null {
  if (!msg.id) return null;
  const toRef = (r: GraphRecipient): PersonRef => ({
    ...(r.emailAddress?.name ? { name: r.emailAddress.name } : {}),
    ...(r.emailAddress?.address ? { email: r.emailAddress.address } : {}),
  });

  const item: RawSourceItem = {
    externalId: msg.id,
    category: 'email',
    title: msg.subject ?? '(no subject)',
    timestamp: msg.receivedDateTime
      ? new Date(msg.receivedDateTime).toISOString()
      : new Date(0).toISOString(),
    isRead: msg.isRead ?? false,
    raw: {
      provider: 'outlook',
      importance: msg.importance ?? null,
      hasAttachments: msg.hasAttachments ?? false,
    },
  };
  if (msg.bodyPreview) {
    item.snippet = msg.bodyPreview;
    item.bodyText = msg.bodyPreview;
  }
  if (msg.from) item.sender = toRef(msg.from);
  const participants = [...(msg.toRecipients ?? []), ...(msg.ccRecipients ?? [])].map(toRef);
  if (participants.length > 0) item.participants = participants;
  if (msg.conversationId) item.threadExternalId = msg.conversationId;
  if (msg.webLink) item.url = msg.webLink;
  return item;
}
