import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchPage } from './SearchPage.js';

const KEYWORD_RESPONSE = {
  results: [
    {
      chunkId: 'rc_1',
      sourceType: 'source_item',
      refId: 'si_1',
      title: 'Quarterly plan review',
      snippet: 'The plan needs a final review before Friday.',
      score: 12.5,
      matchType: 'keyword',
      sourceLabel: 'Gmail',
      category: 'email',
    },
  ],
  mode: 'keyword',
};

function stubSearch(response: unknown = KEYWORD_RESPONSE) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => response,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SearchPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SearchPage', () => {
  it('shows an inviting empty state and does not fetch without a query', () => {
    const fetchMock = stubSearch();
    renderPage();
    expect(screen.getByText('Search everything Jarvis knows')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('debounces input, fetches with q + types, and highlights matching tokens', async () => {
    const fetchMock = stubSearch();
    const { container } = renderPage();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'plan' },
    });
    // Debounced: no request fires synchronously with the keystroke.
    expect(fetchMock).not.toHaveBeenCalled();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('missing fetch call');
    expect(String(firstCall[0])).toBe(
      '/api/search?q=plan&types=source_item,uploaded_file,memory,digest',
    );

    expect(await screen.findByText('Quarterly plan review')).toBeInTheDocument();
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.textContent?.toLowerCase()).toBe('plan');
    expect(marks[0]?.className).toContain('bg-jarvis-100');
  });

  it('shows the keyword mode chip with the semantic-search tooltip', async () => {
    stubSearch();
    renderPage();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'plan' },
    });

    // The chip wrapper carries the explanatory tooltip; its text is the mode.
    const chipWrap = await screen.findByTitle(/embedding-capable/i);
    expect(chipWrap.textContent).toBe('keyword');
  });

  it('narrows the types query param when a type filter is unchecked', async () => {
    const fetchMock = stubSearch();
    renderPage();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Digests' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'plan' },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('missing fetch call');
    expect(String(firstCall[0])).toBe(
      '/api/search?q=plan&types=source_item,uploaded_file,memory',
    );
  });
});
