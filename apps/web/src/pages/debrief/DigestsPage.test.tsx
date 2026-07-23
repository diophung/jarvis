import type { Digest } from '@jarvis/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigestsPage } from '../DigestsPage.js';

const baseDigest: Digest = {
  id: 'dig_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  kind: 'daily',
  status: 'ready',
  generatedAt: '2026-06-09T07:00:00.000Z',
  periodStart: '2026-06-08T07:00:00.000Z',
  periodEnd: '2026-06-09T07:00:00.000Z',
  summaryMarkdown: 'Summary',
  planMarkdown: 'Plan',
  modelUsed: null,
  stats: { most_important: 1, follow_ups: 1, totalConsidered: 8, ignored: 2 },
  supersedesDigestId: null,
  error: null,
  createdAt: '2026-06-09T07:00:00.000Z',
};

// Newest first per contract: dig_2 (manual regenerate) supersedes dig_1.
const digests: Digest[] = [
  {
    ...baseDigest,
    id: 'dig_2',
    kind: 'manual',
    generatedAt: '2026-06-09T09:00:00.000Z',
    supersedesDigestId: 'dig_1',
    stats: { most_important: 2, most_urgent: 1, totalConsidered: 10, ignored: 3 },
  },
  baseDigest,
];

function stubFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(handler(url)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/digests']}>
        <DigestsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DigestsPage', () => {
  it('lists digests newest first, linking to detail, with section counts', async () => {
    stubFetch((url) => {
      if (url.includes('/api/digests')) return { items: digests };
      throw new Error(`unexpected request: ${url}`);
    });
    renderPage();

    const links = (await screen.findAllByRole('link')).filter((a) =>
      a.getAttribute('href')?.startsWith('/digests/'),
    );
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/digests/dig_2', '/digests/dig_1']);

    // Headline stats use plain-language section labels with counts
    const newest = links[0]!;
    expect(within(newest).getByText('Most Important')).toBeInTheDocument();
    expect(within(newest).getByText('2')).toBeInTheDocument();
    expect(within(newest).getByText('manual')).toBeInTheDocument();
    expect(within(newest).getByText('ready')).toBeInTheDocument();
  });

  it('marks a digest as superseded when a newer one points at it', async () => {
    stubFetch((url) => {
      if (url.includes('/api/digests')) return { items: digests };
      throw new Error(`unexpected request: ${url}`);
    });
    renderPage();

    const badges = await screen.findAllByText('superseded');
    expect(badges).toHaveLength(1);
    // The badge sits inside the dig_1 row (the one that was superseded by dig_2)
    expect(badges[0]!.closest('a')).toHaveAttribute('href', '/digests/dig_1');
  });

  it('shows an empty state when there are no digests', async () => {
    stubFetch(() => ({ items: [] }));
    renderPage();

    expect(await screen.findByText('No digests yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to daily debrief/i })).toHaveAttribute(
      'href',
      '/debrief',
    );
  });
});
