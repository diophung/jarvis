import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackConnector, mapSlackMessage } from './slack.js';
import { makeCtx } from '../test-helpers.js';

const SLACK_ENV = { SLACK_BOT_TOKEN: 'xoxb-test-token' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SlackConnector healthCheck', () => {
  it('reports not configured when the bot token is missing', async () => {
    const connector = new SlackConnector();
    const health = await connector.healthCheck(makeCtx());
    expect(health.ok).toBe(false);
    expect(health.message).toBe('not configured: missing env SLACK_BOT_TOKEN');
  });

  it('uses auth.test when configured', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/auth.test');
      return jsonResponse({ ok: true, team: 'meridian' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new SlackConnector();
    const health = await connector.healthCheck(makeCtx({ secretValues: SLACK_ENV }));
    expect(health.ok).toBe(true);
    expect(health.message).toContain('meridian');
  });
});

describe('SlackConnector sync (fetch-mocked)', () => {
  function stubSlackApi(): ReturnType<typeof vi.fn> {
    let userInfoCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/conversations.list')) {
        return jsonResponse({
          ok: true,
          channels: [{ id: 'C001', name: 'atlas-launch' }],
        });
      }
      if (url.includes('/conversations.history')) {
        expect(url).toContain('channel=C001');
        return jsonResponse({
          ok: true,
          messages: [
            { type: 'message', user: 'U123', text: 'cert renewal needs approval ASAP', ts: '1770000300.000200' },
            { type: 'message', subtype: 'channel_join', user: 'U999', ts: '1770000200.000100' },
            { type: 'message', user: 'U123', text: 'soak test passed', ts: '1770000100.000100' },
          ],
        });
      }
      if (url.includes('/users.info')) {
        userInfoCalls += 1;
        expect(userInfoCalls, 'users.info should be cached per user').toBeLessThanOrEqual(1);
        expect(url).toContain('user=U123');
        return jsonResponse({
          ok: true,
          user: {
            name: 'priya',
            profile: { real_name: 'Priya Sharma', email: 'priya.sharma@meridianlabs.com' },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    return fetchMock;
  }

  it('lists channels, fetches history, resolves senders via cached users.info', async () => {
    const fetchMock = stubSlackApi();
    vi.stubGlobal('fetch', fetchMock);

    const connector = new SlackConnector();
    const ctx = makeCtx({ secretValues: SLACK_ENV });
    const page = await connector.sync(ctx, { mode: 'full', limit: 50 });

    expect(page.done).toBe(true);
    // The channel_join subtype is skipped.
    expect(page.items).toHaveLength(2);

    const first = page.items[0];
    expect(first).toMatchObject({
      externalId: 'C001:1770000300.000200',
      category: 'chat',
      threadExternalId: 'C001',
      bodyText: 'cert renewal needs approval ASAP',
    });
    expect(first?.title).toBe('#atlas-launch: cert renewal needs approval ASAP');
    expect(first?.sender).toEqual({
      name: 'Priya Sharma',
      email: 'priya.sharma@meridianlabs.com',
      handle: 'priya',
    });
    expect(first?.timestamp).toBe(new Date(1_770_000_300_000.2).toISOString());

    // Cursor carries the max ts as the next oldest watermark.
    expect(JSON.parse(page.nextCursor ?? '{}')).toEqual({ oldest: '1770000300.0002' });

    // users.info called exactly once for two messages from the same user.
    const userInfoUrls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('users.info'));
    expect(userInfoUrls).toHaveLength(1);
  });

  it('incremental sync passes the oldest watermark to conversations.history', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/conversations.list')) {
        return jsonResponse({ ok: true, channels: [{ id: 'C001', name: 'atlas-launch' }] });
      }
      if (url.includes('/conversations.history')) {
        expect(url).toContain('oldest=1770000300.0002');
        return jsonResponse({ ok: true, messages: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new SlackConnector();
    const page = await connector.sync(makeCtx({ secretValues: SLACK_ENV }), {
      mode: 'incremental',
      cursor: JSON.stringify({ oldest: '1770000300.0002' }),
    });
    expect(page.items).toEqual([]);
    expect(page.done).toBe(true);
  });

  it('honors settings.channelIds instead of conversations.list', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/conversations.list')) throw new Error('should not list channels');
      if (url.includes('/conversations.history')) return jsonResponse({ ok: true, messages: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new SlackConnector();
    const ctx = makeCtx({ secretValues: SLACK_ENV, settings: { channelIds: ['C777'] } });
    const page = await connector.sync(ctx, { mode: 'full' });
    expect(page.done).toBe(true);
    const historyUrl = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('conversations.history'));
    expect(historyUrl).toContain('channel=C777');
  });
});

describe('SlackConnector execute (fetch-mocked)', () => {
  it('posts a message via chat.postMessage and returns channel:ts as the ref', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain('/chat.postMessage');
      const body = JSON.parse(String(init?.body)) as { channel: string; text: string };
      expect(body).toEqual({ channel: 'C001', text: 'Approved — shipping it.' });
      return jsonResponse({ ok: true, channel: 'C001', ts: '1770000400.000100' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new SlackConnector();
    const result = await connector.execute(makeCtx({ secretValues: SLACK_ENV }), {
      type: 'post_message',
      params: { channel: 'C001', text: 'Approved — shipping it.' },
    });
    expect(result.ok).toBe(true);
    expect(result.externalRef).toBe('C001:1770000400.000100');
  });

  it('surfaces Slack API errors as a failed result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: 'channel_not_found' })),
    );
    const connector = new SlackConnector();
    const result = await connector.execute(makeCtx({ secretValues: SLACK_ENV }), {
      type: 'post_message',
      params: { channel: 'C404', text: 'hello?' },
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('channel_not_found');
  });

  it('rejects unsupported actions', async () => {
    const connector = new SlackConnector();
    const result = await connector.execute(makeCtx({ secretValues: SLACK_ENV }), {
      type: 'send_email',
      params: {},
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/does not support/);
  });
});

describe('mapSlackMessage', () => {
  it('threads replies under channel:thread_ts', () => {
    const item = mapSlackMessage(
      { id: 'C9', name: 'general' },
      { type: 'message', text: 'reply', ts: '2.0', thread_ts: '1.0' },
      undefined,
    );
    expect(item.threadExternalId).toBe('C9:1.0');
    expect(item.externalId).toBe('C9:2.0');
  });

  it('falls back to the raw user id as handle when users.info is unavailable', () => {
    const item = mapSlackMessage(
      { id: 'C9', name: 'general' },
      { type: 'message', user: 'U42', text: 'hi', ts: '3.0' },
      undefined,
    );
    expect(item.sender).toEqual({ handle: 'U42' });
  });
});
