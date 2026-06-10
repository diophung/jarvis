/**
 * Slack connector hook.
 *
 * Untested-against-live-API hook: request/response structures follow the
 * current public Slack Web API docs (https://api.slack.com/methods) but have
 * not been exercised against a live workspace.
 *
 * Sync strategy:
 *  - conversations.list to discover channels (or `settings.channelIds` to
 *    restrict the set);
 *  - conversations.history per channel with `oldest=<cursor ts>` for
 *    incremental syncs;
 *  - users.info with an in-memory cache to resolve sender names.
 *
 * Write side (approval flow only): `post_message` via chat.postMessage.
 *
 * Required env: SLACK_BOT_TOKEN (least-privilege scopes listed on the
 * descriptor). The token value is read via ctx.secrets at call time and never
 * logged.
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
import { parseJsonCursor } from '../util/parse.js';

export const SLACK_BASE_URL = 'https://slack.com/api';
export const SLACK_REQUIRED_ENV = ['SLACK_BOT_TOKEN'] as const;

const DEFAULT_LIMIT = 50;
const MAX_CHANNELS = 20;

interface SlackCursor extends Record<string, unknown> {
  /** Slack ts watermark — only messages strictly newer are fetched. */
  oldest?: string;
}

interface SlackChannel {
  id?: string;
  name?: string;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

interface SlackUserInfo {
  name?: string;
  realName?: string;
  email?: string;
}

export class SlackConnector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'slack',
    category: 'chat',
    label: 'Slack',
    description: 'Slack workspace channels via the Web API (bot token).',
    capabilities: ['read', 'list', 'search', 'send'],
    scopes: ['channels:read', 'channels:history', 'users:read', 'users:read.email', 'chat:write'],
    requiredEnv: [...SLACK_REQUIRED_ENV],
    local: false,
  };

  /** users.info cache, keyed by `${accountId}:${userId}` (never by token). */
  private readonly userCache = new Map<string, SlackUserInfo>();

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const token = ctx.secrets.get('SLACK_BOT_TOKEN');
    if (!token) {
      return { ok: false, message: 'not configured: missing env SLACK_BOT_TOKEN' };
    }
    try {
      const json = await this.call<{ ok: boolean; team?: string; error?: string }>(
        token,
        'auth.test',
        new URLSearchParams(),
      );
      if (!json.ok) return { ok: false, message: `Slack auth.test failed: ${json.error ?? 'unknown'}` };
      return { ok: true, message: `Slack reachable (team: ${json.team ?? 'unknown'})` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Slack health check failed' };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const token = this.requireToken(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;
    const cursor = parseJsonCursor<SlackCursor>(req.cursor) ?? {};
    const oldest = req.mode === 'incremental' ? cursor.oldest : undefined;

    const channels = await this.listChannels(ctx, token);
    const items: RawSourceItem[] = [];
    let maxTs = typeof oldest === 'string' ? Number.parseFloat(oldest) : 0;
    if (!Number.isFinite(maxTs)) maxTs = 0;

    for (const channel of channels) {
      if (!channel.id) continue;
      const params = new URLSearchParams({ channel: channel.id, limit: String(limit) });
      if (typeof oldest === 'string' && oldest) params.set('oldest', oldest);
      const history = await this.call<{
        ok: boolean;
        error?: string;
        messages?: SlackMessage[];
      }>(token, 'conversations.history', params);
      if (!history.ok) {
        ctx.logger.warn(`slack: conversations.history failed for a channel: ${history.error ?? 'unknown'}`);
        continue;
      }
      for (const msg of history.messages ?? []) {
        if (msg.type !== 'message' || msg.subtype !== undefined || !msg.ts) continue;
        const sender = msg.user ? await this.resolveUser(ctx, token, msg.user) : undefined;
        items.push(mapSlackMessage(channel, msg, sender));
        const ts = Number.parseFloat(msg.ts);
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
      }
    }

    const nextCursor: SlackCursor = { oldest: maxTs > 0 ? String(maxTs) : undefined };
    return { items, nextCursor: JSON.stringify(nextCursor), done: true };
  }

  async execute(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult> {
    if (action.type !== 'post_message') {
      return { ok: false, detail: `slack does not support action '${action.type}'` };
    }
    const channel = typeof action.params['channel'] === 'string' ? action.params['channel'] : '';
    const text = typeof action.params['text'] === 'string' ? action.params['text'] : '';
    if (!channel || !text) {
      return { ok: false, detail: "post_message requires 'channel' and 'text' params" };
    }
    try {
      const token = this.requireToken(ctx);
      const res = await fetch(`${SLACK_BASE_URL}/chat.postMessage`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text }),
      });
      if (!res.ok) return { ok: false, detail: `Slack post failed: HTTP ${res.status}` };
      const json = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
      if (!json.ok) return { ok: false, detail: `Slack post failed: ${json.error ?? 'unknown'}` };
      return {
        ok: true,
        externalRef: `${json.channel ?? channel}:${json.ts ?? ''}`,
        detail: `Message posted to ${channel}`,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Slack post failed' };
    }
  }

  private requireToken(ctx: ConnectorContext): string {
    const token = ctx.secrets.get('SLACK_BOT_TOKEN');
    if (!token) throw new Error('not configured: missing env SLACK_BOT_TOKEN');
    return token;
  }

  private async call<T>(token: string, method: string, params: URLSearchParams): Promise<T> {
    const query = params.toString();
    const res = await fetch(`${SLACK_BASE_URL}/${method}${query ? `?${query}` : ''}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Slack ${method} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async listChannels(ctx: ConnectorContext, token: string): Promise<SlackChannel[]> {
    const configured = ctx.settings['channelIds'];
    if (Array.isArray(configured) && configured.length > 0) {
      return configured
        .filter((id): id is string => typeof id === 'string')
        .map((id) => ({ id, name: id }));
    }
    const json = await this.call<{ ok: boolean; error?: string; channels?: SlackChannel[] }>(
      token,
      'conversations.list',
      new URLSearchParams({
        types: 'public_channel',
        exclude_archived: 'true',
        limit: String(MAX_CHANNELS),
      }),
    );
    if (!json.ok) throw new Error(`Slack conversations.list failed: ${json.error ?? 'unknown'}`);
    return json.channels ?? [];
  }

  private async resolveUser(
    ctx: ConnectorContext,
    token: string,
    userId: string,
  ): Promise<SlackUserInfo> {
    const cacheKey = `${ctx.accountId}:${userId}`;
    const cached = this.userCache.get(cacheKey);
    if (cached) return cached;
    try {
      const json = await this.call<{
        ok: boolean;
        user?: { name?: string; real_name?: string; profile?: { email?: string; real_name?: string } };
      }>(token, 'users.info', new URLSearchParams({ user: userId }));
      const info: SlackUserInfo = json.ok
        ? {
            name: json.user?.name,
            realName: json.user?.profile?.real_name ?? json.user?.real_name,
            email: json.user?.profile?.email,
          }
        : {};
      this.userCache.set(cacheKey, info);
      return info;
    } catch {
      const info: SlackUserInfo = {};
      this.userCache.set(cacheKey, info);
      return info;
    }
  }
}

/** Map a Slack message to Donna's RawSourceItem. */
export function mapSlackMessage(
  channel: SlackChannel,
  msg: SlackMessage,
  sender?: SlackUserInfo,
): RawSourceItem {
  const ts = msg.ts ?? '0';
  const tsMs = Math.round(Number.parseFloat(ts) * 1000);
  const text = msg.text ?? '';
  const channelLabel = channel.name ? `#${channel.name}` : (channel.id ?? 'channel');

  const item: RawSourceItem = {
    externalId: `${channel.id ?? 'unknown'}:${ts}`,
    category: 'chat',
    title: `${channelLabel}: ${text.slice(0, 80) || '(no text)'}`,
    timestamp: new Date(Number.isFinite(tsMs) ? tsMs : 0).toISOString(),
    threadExternalId: msg.thread_ts ? `${channel.id ?? 'unknown'}:${msg.thread_ts}` : (channel.id ?? 'unknown'),
    raw: { provider: 'slack', channelId: channel.id ?? null, ts },
  };
  if (text) item.bodyText = text;
  if (sender && (sender.realName ?? sender.name ?? sender.email)) {
    const ref: PersonRef = {};
    const name = sender.realName ?? sender.name;
    if (name) ref.name = name;
    if (sender.email) ref.email = sender.email;
    if (sender.name) ref.handle = sender.name;
    item.sender = ref;
  } else if (msg.user) {
    item.sender = { handle: msg.user };
  }
  return item;
}
