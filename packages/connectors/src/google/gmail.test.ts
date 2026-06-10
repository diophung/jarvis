import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailConnector, mapGmailMessage } from './gmail.js';
import { GoogleAuth, GOOGLE_TOKEN_URL } from './google-auth.js';
import { makeCtx } from '../test-helpers.js';

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GmailConnector healthCheck', () => {
  it('reports not configured with the missing env names when secrets are absent', async () => {
    const connector = new GmailConnector();
    const health = await connector.healthCheck(makeCtx());
    expect(health.ok).toBe(false);
    expect(health.message).toBe(
      'not configured: missing env GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN',
    );
  });

  it('lists only the env vars actually missing', async () => {
    const connector = new GmailConnector();
    const health = await connector.healthCheck(
      makeCtx({ secretValues: { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' } }),
    );
    expect(health.ok).toBe(false);
    expect(health.message).toBe('not configured: missing env GOOGLE_REFRESH_TOKEN');
  });
});

describe('GmailConnector sync (fetch-mocked)', () => {
  it('exchanges the refresh token, lists messages, and maps them to RawSourceItems', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === GOOGLE_TOKEN_URL) {
        return jsonResponse({ access_token: 'token-123', expires_in: 3600 });
      }
      if (url.includes('/users/me/messages?')) {
        return jsonResponse({ messages: [{ id: 'msg-1' }, { id: 'msg-2' }] });
      }
      if (url.includes('/users/me/messages/msg-1')) {
        return jsonResponse({
          id: 'msg-1',
          threadId: 'thread-9',
          snippet: 'Quarterly numbers attached…',
          internalDate: '1770000000000',
          labelIds: ['INBOX', 'UNREAD'],
          payload: {
            headers: [
              { name: 'Subject', value: 'Quarterly numbers' },
              { name: 'From', value: 'Maya Lindqvist <maya@meridianlabs.com>' },
              { name: 'To', value: 'Alex Chen <alex@meridianlabs.com>, ops@meridianlabs.com' },
            ],
          },
        });
      }
      if (url.includes('/users/me/messages/msg-2')) {
        return jsonResponse({
          id: 'msg-2',
          threadId: 'thread-9',
          snippet: 'Re: numbers',
          internalDate: '1770000100000',
          labelIds: ['INBOX'],
          payload: { headers: [{ name: 'Subject', value: 'Re: Quarterly numbers' }] },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new GmailConnector(new GoogleAuth(() => 1_770_000_000_000));
    const ctx = makeCtx({ secretValues: GOOGLE_ENV });
    const page = await connector.sync(ctx, { mode: 'full', limit: 25 });

    expect(page.done).toBe(true);
    expect(page.items).toHaveLength(2);

    const first = page.items[0];
    expect(first).toMatchObject({
      externalId: 'msg-1',
      category: 'email',
      title: 'Quarterly numbers',
      threadExternalId: 'thread-9',
      isRead: false,
      snippet: 'Quarterly numbers attached…',
    });
    expect(first?.timestamp).toBe(new Date(1_770_000_000_000).toISOString());
    expect(first?.sender).toEqual({ name: 'Maya Lindqvist', email: 'maya@meridianlabs.com' });
    expect(first?.participants).toEqual([
      { name: 'Alex Chen', email: 'alex@meridianlabs.com' },
      { email: 'ops@meridianlabs.com' },
    ]);
    expect(page.items[1]?.isRead).toBe(true);

    // Final cursor carries the max internalDate for the next incremental run.
    expect(JSON.parse(page.nextCursor ?? '{}')).toEqual({ sinceMs: 1_770_000_100_000 });

    // The list call carried the limit and a q filter.
    const listCall = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/users/me/messages?'));
    expect(listCall).toContain('maxResults=25');
    expect(listCall).toContain('q=');
  });

  it('incremental sync derives an after: query from the cursor', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === GOOGLE_TOKEN_URL) return jsonResponse({ access_token: 't', expires_in: 3600 });
      if (url.includes('/users/me/messages?')) return jsonResponse({ messages: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new GmailConnector(new GoogleAuth(() => 0));
    const ctx = makeCtx({ secretValues: GOOGLE_ENV });
    const page = await connector.sync(ctx, {
      mode: 'incremental',
      cursor: JSON.stringify({ sinceMs: 1_770_000_100_000 }),
    });

    expect(page.items).toEqual([]);
    expect(page.done).toBe(true);
    const listCall = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/users/me/messages?'));
    expect(listCall).toContain(`q=after%3A${Math.floor(1_770_000_100_000 / 1000)}`);
  });
});

describe('GmailConnector execute (fetch-mocked)', () => {
  it('sends a base64url RFC822 message via users/me/messages/send', async () => {
    let sentRaw = '';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === GOOGLE_TOKEN_URL) return jsonResponse({ access_token: 't', expires_in: 3600 });
      if (url.includes('/users/me/messages/send')) {
        const body = JSON.parse(String(init?.body)) as { raw: string };
        sentRaw = body.raw;
        return jsonResponse({ id: 'sent-1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new GmailConnector(new GoogleAuth(() => 0));
    const ctx = makeCtx({ secretValues: GOOGLE_ENV });
    const result = await connector.execute(ctx, {
      type: 'send_email',
      params: { to: 'daniel@northwind.io', subject: 'Rollout plan', body: 'Phased it is.' },
    });

    expect(result.ok).toBe(true);
    expect(result.externalRef).toBe('sent-1');
    const decoded = Buffer.from(sentRaw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: daniel@northwind.io');
    expect(decoded).toContain('Subject: Rollout plan');
    expect(decoded).toContain('Phased it is.');
  });

  it('rejects unsupported actions without network calls', async () => {
    const connector = new GmailConnector();
    const result = await connector.execute(makeCtx({ secretValues: GOOGLE_ENV }), {
      type: 'delete_mailbox',
      params: {},
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/does not support/);
  });
});

describe('mapGmailMessage', () => {
  it('returns null without an id and defaults a missing subject', () => {
    expect(mapGmailMessage({})).toBeNull();
    const item = mapGmailMessage({ id: 'x', internalDate: '1000' });
    expect(item?.title).toBe('(no subject)');
  });
});
