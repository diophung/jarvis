import type { DigestItem } from '@donna/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebriefPage } from '../DebriefPage.js';
import type { DigestWithItems } from './types.js';

const baseItem: DigestItem = {
  id: 'di_1',
  digestId: 'dig_1',
  workspaceId: 'ws_1',
  sourceItemId: 'src_1',
  taskCandidateId: null,
  title: 'Board deck review requested',
  sourceLabel: 'Gmail',
  sourceCategory: 'email',
  itemTimestamp: '2026-06-09T06:10:00.000Z',
  section: 'most_important',
  planningCategory: 'do_now',
  priorityLevel: 'critical',
  urgencyLevel: 'high',
  effortLevel: 'medium',
  recommendedAction: 'Reply to Sarah with your edits before 11:00',
  explanation: 'Sarah (VIP) asked for your review and the board meets tomorrow.',
  signals: [{ key: 'vip_sender', label: 'From a VIP', weight: 30, detail: 'Sarah Chen' }],
  rank: 1,
  createdAt: '2026-06-09T07:00:00.000Z',
};

const latestDigest: DigestWithItems = {
  id: 'dig_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  kind: 'daily',
  status: 'ready',
  generatedAt: '2026-06-09T07:00:00.000Z',
  periodStart: '2026-06-08T07:00:00.000Z',
  periodEnd: '2026-06-09T07:00:00.000Z',
  summaryMarkdown: 'Good morning. **Two things** truly need you today.',
  planMarkdown: 'Start with the board deck, then close out the legal follow-up.',
  modelUsed: null,
  stats: { most_important: 1, follow_ups: 1, totalConsidered: 12, ignored: 4 },
  supersedesDigestId: null,
  error: null,
  createdAt: '2026-06-09T07:00:00.000Z',
  items: [
    baseItem,
    {
      ...baseItem,
      id: 'di_2',
      sourceItemId: 'src_2',
      title: 'Ping legal about the MSA',
      sourceLabel: 'Slack',
      sourceCategory: 'chat',
      section: 'follow_ups',
      planningCategory: 'follow_up',
      priorityLevel: 'medium',
      urgencyLevel: 'medium',
      effortLevel: 'low',
      recommendedAction: null,
      rank: 1,
    },
  ],
};

let calls: { url: string; init: RequestInit | undefined }[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify(handler(url, init)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/debrief" element={<DebriefPage />} />
          <Route path="/digests/:digestId" element={<DebriefPage />} />
          <Route path="/digests" element={<div>history page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DebriefPage', () => {
  it('renders the latest debrief with summary, sections, items, and stats', async () => {
    stubFetch((url) => {
      if (url.includes('/api/digests/latest')) return { digest: latestDigest };
      throw new Error(`unexpected request: ${url}`);
    });
    renderAt('/debrief');

    expect(await screen.findByText('Daily Debrief')).toBeInTheDocument();
    // Summary markdown rendered
    expect(screen.getByText('Two things')).toBeInTheDocument();
    // Sections in DIGEST_SECTIONS order with plain-language labels
    expect(screen.getByText('Most Important')).toBeInTheDocument();
    expect(screen.getByText('Unresolved Follow-ups')).toBeInTheDocument();
    // Item content
    expect(screen.getByText('Board deck review requested')).toBeInTheDocument();
    expect(screen.getByText(/Reply to Sarah with your edits/)).toBeInTheDocument();
    expect(screen.getByText('critical priority')).toBeInTheDocument();
    // Plan + stats footer
    expect(screen.getByText('Suggested plan for today')).toBeInTheDocument();
    expect(
      screen.getByText('Considered 12 items · ignored 4 low-signal items'),
    ).toBeInTheDocument();

    // "Why this matters" disclosure reveals scoring signals
    const disclosure = screen.getAllByText('Why this matters')[0];
    expect(disclosure).toBeDefined();
    fireEvent.click(disclosure!);
    expect(await screen.findByText('From a VIP')).toBeInTheDocument();
  });

  it('regenerates with the current digest id as supersedesDigestId', async () => {
    stubFetch((url) => {
      if (url.includes('/api/digests/generate')) {
        return {
          digest: { ...latestDigest, id: 'dig_2', kind: 'manual', supersedesDigestId: 'dig_1' },
        };
      }
      if (url.includes('/api/digests/latest')) return { digest: latestDigest };
      throw new Error(`unexpected request: ${url}`);
    });
    renderAt('/debrief');

    fireEvent.click(await screen.findByRole('button', { name: /regenerate/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/api/digests/generate'));
      expect(post).toBeDefined();
      expect(post!.init?.method).toBe('POST');
      expect(JSON.parse(String(post!.init?.body))).toEqual({
        kind: 'manual',
        supersedesDigestId: 'dig_1',
      });
    });
  });

  it('shows a generate CTA when no digest exists yet', async () => {
    stubFetch((url) => {
      if (url.includes('/api/digests/generate')) return { digest: latestDigest };
      if (url.includes('/api/digests/latest')) return { digest: null };
      throw new Error(`unexpected request: ${url}`);
    });
    renderAt('/debrief');

    expect(await screen.findByText('No debrief yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /generate my debrief/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/api/digests/generate'));
      expect(post).toBeDefined();
      expect(JSON.parse(String(post!.init?.body))).toEqual({ kind: 'manual' });
    });
  });

  it('shows a past-version notice with a link back when viewing an old digest', async () => {
    const oldDigest: DigestWithItems = { ...latestDigest, id: 'dig_0', kind: 'manual' };
    stubFetch((url) => {
      if (url.includes('/api/digests/dig_0')) return { digest: oldDigest };
      throw new Error(`unexpected request: ${url}`);
    });
    renderAt('/digests/dig_0');

    expect(await screen.findByText(/viewing a past debrief/i)).toBeInTheDocument();
    const back = screen.getByRole('link', { name: /back to the latest/i });
    expect(back).toHaveAttribute('href', '/debrief');
  });
});
