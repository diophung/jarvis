/**
 * Microsoft Teams (Graph) connector hook — reads the user's chats.
 *
 * Untested-against-live-API hook: request/response structures follow the
 * current public Microsoft Graph v1.0 docs
 * (https://learn.microsoft.com/graph/api/chat-list,
 *  https://learn.microsoft.com/graph/api/chat-list-messages) but have not
 * been exercised against a live tenant.
 *
 * Sync strategy: list /v1.0/me/chats, then page messages per chat. Graph's
 * chat-message listing has limited server-side filtering, so incremental
 * syncs filter client-side on createdDateTime > cursor.
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
import { parseJsonCursor, stripHtml } from '../util/parse.js';
import { httpErrorDetail } from '../util/parse.js';

const DEFAULT_LIMIT = 50;
const MAX_CHATS = 20;

interface TeamsCursor extends Record<string, unknown> {
  /** ISO createdDateTime lower bound for incremental syncs. */
  sinceIso?: string;
}

interface GraphChat {
  id?: string;
  topic?: string | null;
  chatType?: string;
}

interface GraphChatMessage {
  id?: string;
  createdDateTime?: string;
  body?: { contentType?: string; content?: string };
  from?: { user?: { displayName?: string; id?: string } };
  webUrl?: string;
}

export class TeamsConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'teams',
    category: 'chat',
    label: 'Microsoft Teams',
    description: "The user's Teams chats via Microsoft Graph (read-only).",
    capabilities: ['read', 'list'],
    scopes: ['Chat.Read'],
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
      const res = await fetch(`${GRAPH_BASE_URL}/me/chats?$top=1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, message: `Teams check failed: ${await httpErrorDetail(res)}` };
      return { ok: true, message: 'Teams chats reachable' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Teams health check failed',
      };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const token = await this.auth.getAccessToken(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;
    const cursor = parseJsonCursor<TeamsCursor>(req.cursor) ?? {};
    const sinceIso = req.mode === 'incremental' ? cursor.sinceIso : undefined;

    const chatsRes = await fetch(`${GRAPH_BASE_URL}/me/chats?$top=${MAX_CHATS}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!chatsRes.ok) throw new Error(`Teams chat list failed: ${await httpErrorDetail(chatsRes)}`);
    const chats = (await chatsRes.json()) as { value?: GraphChat[] };

    const items: RawSourceItem[] = [];
    let maxSeenIso = sinceIso ?? '';
    for (const chat of chats.value ?? []) {
      if (!chat.id) continue;
      const msgRes = await fetch(
        `${GRAPH_BASE_URL}/me/chats/${encodeURIComponent(chat.id)}/messages?$top=${limit}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!msgRes.ok) continue;
      const msgs = (await msgRes.json()) as { value?: GraphChatMessage[] };
      for (const msg of msgs.value ?? []) {
        if (sinceIso && msg.createdDateTime !== undefined && msg.createdDateTime <= sinceIso) {
          continue;
        }
        const item = mapTeamsMessage(chat, msg);
        if (item) {
          items.push(item);
          if (msg.createdDateTime && msg.createdDateTime > maxSeenIso) {
            maxSeenIso = msg.createdDateTime;
          }
        }
      }
    }

    const nextCursor: TeamsCursor = { sinceIso: maxSeenIso || undefined };
    return { items, nextCursor: JSON.stringify(nextCursor), done: true };
  }
}

/** Map a Graph chatMessage resource to Donna's RawSourceItem. */
export function mapTeamsMessage(chat: GraphChat, msg: GraphChatMessage): RawSourceItem | null {
  if (!msg.id || !chat.id) return null;
  const text =
    msg.body?.contentType === 'html' ? stripHtml(msg.body.content ?? '') : (msg.body?.content ?? '');
  const chatLabel = chat.topic ?? (chat.chatType === 'oneOnOne' ? 'Direct chat' : 'Group chat');
  const senderName = msg.from?.user?.displayName;

  const item: RawSourceItem = {
    externalId: `${chat.id}:${msg.id}`,
    category: 'chat',
    title: `${chatLabel}: ${text.slice(0, 80) || '(no text)'}`,
    timestamp: msg.createdDateTime
      ? new Date(msg.createdDateTime).toISOString()
      : new Date(0).toISOString(),
    threadExternalId: chat.id,
    raw: { provider: 'teams', chatType: chat.chatType ?? null },
  };
  if (text) item.bodyText = text;
  if (senderName) item.sender = { name: senderName, handle: msg.from?.user?.id ?? undefined };
  if (msg.webUrl) item.url = msg.webUrl;
  return item;
}
