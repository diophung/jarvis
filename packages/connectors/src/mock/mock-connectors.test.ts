import { describe, expect, it } from 'vitest';
import type { RawSourceItem } from '@donna/core';
import type { Connector, SyncRequest } from '../types.js';
import { createDemoDataset } from '../demo/dataset.js';
import { MockEmailConnector } from './mock-email.js';
import { MockChatConnector } from './mock-chat.js';
import { MockCalendarConnector } from './mock-calendar.js';
import { MockStorageConnector } from './mock-storage.js';
import { parseMockCursor, serveMockPage } from './base.js';
import { makeCtx } from '../test-helpers.js';

const NOW_ISO = '2026-06-09T10:30:00.000Z';
const NOW = new Date(NOW_ISO);
const ctx = makeCtx({ settings: { demoNow: NOW_ISO } });
const dataset = createDemoDataset(NOW);

/** Run a connector through a full sync loop, collecting all pages. */
async function fullSync(
  connector: Connector,
  limit?: number,
): Promise<{ items: RawSourceItem[]; pages: number; finalCursor: string | null }> {
  const items: RawSourceItem[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const req: SyncRequest = { mode: 'full', cursor, limit };
    const page = await connector.sync(ctx, req);
    items.push(...page.items);
    pages += 1;
    cursor = page.nextCursor;
    if (page.done) return { items, pages, finalCursor: cursor };
    if (pages > 100) throw new Error('runaway pagination');
  }
}

describe('mock connector sync semantics', () => {
  const cases: Array<{
    name: string;
    connector: Connector;
    base: RawSourceItem[];
    incremental: RawSourceItem[];
  }> = [
    {
      name: 'mock-email',
      connector: new MockEmailConnector(),
      base: dataset.emails,
      incremental: dataset.incremental.email,
    },
    {
      name: 'mock-chat',
      connector: new MockChatConnector(),
      base: dataset.chatMessages,
      incremental: dataset.incremental.chat,
    },
    {
      name: 'mock-calendar',
      connector: new MockCalendarConnector(),
      base: dataset.calendarEvents,
      incremental: dataset.incremental.calendar,
    },
    {
      name: 'mock-storage',
      connector: new MockStorageConnector(),
      base: dataset.storageFiles,
      incremental: dataset.incremental.storage,
    },
  ];

  for (const { name, connector, base, incremental } of cases) {
    describe(name, () => {
      it('reports a healthy local descriptor', async () => {
        const health = await connector.healthCheck(ctx);
        expect(health.ok).toBe(true);
        expect(connector.descriptor.provider).toBe(name);
        expect(connector.descriptor.local).toBe(true);
        expect(connector.descriptor.requiredEnv).toEqual([]);
        if (connector.execute) {
          expect(
            connector.descriptor.capabilities.some((c) =>
              ['send', 'create', 'update'].includes(c),
            ),
          ).toBe(true);
        }
      });

      it('full sync pages through the base dataset in order', async () => {
        const { items, pages } = await fullSync(connector, 5);
        expect(items.map((i) => i.externalId)).toEqual(base.map((i) => i.externalId));
        expect(pages).toBe(Math.ceil(base.length / 5));
      });

      it('full sync with default limit returns everything in one page', async () => {
        const page = await connector.sync(ctx, { mode: 'full' });
        expect(page.items.length).toBe(base.length);
        expect(page.done).toBe(true);
        expect(page.nextCursor).toBe(`synced:${base.length}`);
      });

      it('first incremental sync after full returns only the new arrivals, then nothing', async () => {
        const { finalCursor } = await fullSync(connector);
        const inc1 = await connector.sync(ctx, { mode: 'incremental', cursor: finalCursor });
        expect(inc1.items.map((i) => i.externalId)).toEqual(
          incremental.map((i) => i.externalId),
        );
        expect(inc1.items.length).toBeGreaterThanOrEqual(1);
        expect(inc1.items.length).toBeLessThanOrEqual(2);
        expect(inc1.done).toBe(true);

        const inc2 = await connector.sync(ctx, { mode: 'incremental', cursor: inc1.nextCursor });
        expect(inc2.items).toEqual([]);
        expect(inc2.done).toBe(true);
      });

      it('incremental sync without a cursor behaves like a full sync', async () => {
        const page = await connector.sync(ctx, { mode: 'incremental', cursor: null });
        expect(page.items.length).toBe(Math.min(base.length, 50));
      });

      it('fetchItem returns items by externalId and null for unknown ids', async () => {
        const first = base[0];
        expect(first).toBeDefined();
        if (!connector.fetchItem || !first) return;
        const fetched = await connector.fetchItem(ctx, first.externalId);
        expect(fetched?.externalId).toBe(first.externalId);
        expect(await connector.fetchItem(ctx, 'does-not-exist')).toBeNull();
      });
    });
  }
});

describe('mock cursor helpers', () => {
  it('parses offset and synced cursors and rejects junk', () => {
    expect(parseMockCursor('offset:10')).toEqual({ kind: 'offset', position: 10 });
    expect(parseMockCursor('synced:3')).toEqual({ kind: 'synced', position: 3 });
    expect(parseMockCursor(null)).toBeNull();
    expect(parseMockCursor(undefined)).toBeNull();
    expect(parseMockCursor('')).toBeNull();
    expect(parseMockCursor('garbage')).toBeNull();
    expect(parseMockCursor('offset:-1')).toBeNull();
  });

  it('clamps a synced cursor beyond the end of the stream', () => {
    const base = dataset.emails;
    const inc = dataset.incremental.email;
    const page = serveMockPage(base, inc, {
      mode: 'incremental',
      cursor: `synced:${base.length + inc.length + 50}`,
    });
    expect(page.items).toEqual([]);
    expect(page.done).toBe(true);
  });

  it('a full resync after incremental restarts from the beginning', () => {
    const base = dataset.emails;
    const inc = dataset.incremental.email;
    const page = serveMockPage(base, inc, { mode: 'full', cursor: 'synced:99' });
    expect(page.items[0]?.externalId).toBe(base[0]?.externalId);
  });
});

describe('mock connector execute (approval-flow demo)', () => {
  it('mock-email send_email and reply_email succeed with fake refs', async () => {
    const connector = new MockEmailConnector();
    const sent = await connector.execute(ctx, {
      type: 'send_email',
      params: { to: 'daniel.reyes@northwind.io', subject: 'Re: rollout', body: 'On it.' },
    });
    expect(sent.ok).toBe(true);
    expect(sent.externalRef).toBe('mock-email-sent-0001');

    const reply = await connector.execute(ctx, {
      type: 'reply_email',
      params: { threadExternalId: 'demo-thread-msa', body: 'Approved as discussed.' },
    });
    expect(reply.ok).toBe(true);
    expect(reply.externalRef).toBe('mock-email-sent-0002');

    const missingParams = await connector.execute(ctx, { type: 'send_email', params: {} });
    expect(missingParams.ok).toBe(false);

    const unknown = await connector.execute(ctx, { type: 'delete_everything', params: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.detail).toMatch(/does not support/);
  });

  it('mock-calendar create_event and update_event succeed with fake refs', async () => {
    const connector = new MockCalendarConnector();
    const created = await connector.execute(ctx, {
      type: 'create_event',
      params: { title: 'Follow-up with Jin', startsAt: '2026-06-10T09:00:00.000Z' },
    });
    expect(created.ok).toBe(true);
    expect(created.externalRef).toBe('mock-event-0001');

    const updated = await connector.execute(ctx, {
      type: 'update_event',
      params: { externalId: 'demo-cal-003' },
    });
    expect(updated.ok).toBe(true);
    expect(updated.externalRef).toBe('demo-cal-003');

    const bad = await connector.execute(ctx, { type: 'create_event', params: {} });
    expect(bad.ok).toBe(false);
  });

  it('mock-chat post_message succeeds with a fake ref', async () => {
    const connector = new MockChatConnector();
    const posted = await connector.execute(ctx, {
      type: 'post_message',
      params: { channel: 'demo-channel-atlas', text: 'Cert approval done.' },
    });
    expect(posted.ok).toBe(true);
    expect(posted.externalRef).toBe('mock-chat-msg-0001');

    const unknown = await connector.execute(ctx, { type: 'send_email', params: {} });
    expect(unknown.ok).toBe(false);
  });

  it('mock-email fetchAttachment returns stable fake content', async () => {
    const connector = new MockEmailConnector();
    const attachment = await connector.fetchAttachment(ctx, 'demo-attachment-msa-v4');
    expect(attachment?.mimeType).toBe('text/plain');
    expect(new TextDecoder().decode(attachment?.data)).toContain('demo-attachment-msa-v4');
  });
});
