import type { MemoryEntry } from '@jarvis/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPage } from '../MemoryPage.js';
import { renderWithProviders, stubFetch } from './test-utils.js';

const NOW = new Date().toISOString();

const explicitMemory: MemoryEntry = {
  id: 'mem_1',
  workspaceId: 'ws_1',
  userId: 'usr_1',
  kind: 'preference',
  content: 'Prefers short replies',
  origin: 'explicit',
  confidence: 1,
  enabled: 1,
  relatedPeopleIds: [],
  relatedProjectIds: [],
  provenance: {},
  lastUsedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const inferredMemory: MemoryEntry = {
  ...explicitMemory,
  id: 'mem_2',
  kind: 'fact',
  content: 'Works at Acme Corp',
  origin: 'inferred',
  confidence: 0.72,
};

function stubMemoryRoutes() {
  return stubFetch([
    { match: '/api/memory/export', reply: () => ({ items: [explicitMemory, inferredMemory] }) },
    {
      match: /\/api\/memory$/,
      reply: () => ({ items: [explicitMemory, inferredMemory], enabled: true }),
    },
    {
      method: 'PUT',
      match: '/api/memory/settings',
      reply: () => ({ enabled: false }),
    },
    {
      method: 'PATCH',
      match: '/api/memory/mem_1',
      reply: () => ({ memory: { ...explicitMemory, content: 'Prefers concise replies' } }),
    },
  ]);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MemoryPage', () => {
  it('renders grouped memories with origin chips and PUTs settings on toggle', async () => {
    const { calls } = stubMemoryRoutes();
    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('Prefers short replies')).toBeInTheDocument();
    expect(screen.getByText('you told Jarvis')).toBeInTheDocument();
    expect(screen.getByText('inferred · 72% sure')).toBeInTheDocument();
    expect(
      screen.getByText('When off, Jarvis stores and uses nothing new about you.'),
    ).toBeInTheDocument();

    // First switch is the master memory toggle.
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]!);

    await waitFor(() => {
      const put = calls.find((c) => c.url.includes('/api/memory/settings'));
      expect(put?.method).toBe('PUT');
      expect(put?.body).toEqual({ enabled: false });
    });
  });

  it('toggles a single memory off with a boolean PATCH', async () => {
    const { calls } = stubMemoryRoutes();
    renderWithProviders(<MemoryPage />);
    await screen.findByText('Prefers short replies');

    // Switch 0 is the master toggle; switch 1 belongs to mem_1.
    fireEvent.click(screen.getAllByRole('switch')[1]!);

    await waitFor(() => {
      const patch = calls.find(
        (c) => c.url.includes('/api/memory/mem_1') && c.method === 'PATCH',
      );
      // Must be a real boolean — the server zod schema rejects 1/0.
      expect(patch?.body).toEqual({ enabled: false });
    });
  });

  it('shows inline feedback when a memory toggle PATCH fails', async () => {
    stubMemoryRoutes();
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/api/memory/mem_1') && method === 'PATCH') {
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
              error: { code: 'bad_request', message: 'Invalid memory patch' },
            }),
          } as unknown as Response;
        }
        return base(input, init);
      }),
    );

    renderWithProviders(<MemoryPage />);
    await screen.findByText('Prefers short replies');
    fireEvent.click(screen.getAllByRole('switch')[1]!);

    expect(
      await screen.findByText(/Couldn’t update memory — Invalid memory patch/),
    ).toBeInTheDocument();
  });

  it('edits a memory inline and PATCHes the new content', async () => {
    const { calls } = stubMemoryRoutes();
    renderWithProviders(<MemoryPage />);

    fireEvent.click(await screen.findByText('Prefers short replies'));
    const textarea = screen.getByDisplayValue('Prefers short replies');
    fireEvent.change(textarea, { target: { value: 'Prefers concise replies' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.url.includes('/api/memory/mem_1'));
      expect(patch?.method).toBe('PATCH');
      expect(patch?.body).toEqual({ content: 'Prefers concise replies' });
    });
  });

  it('exports memory as a downloadable jarvis-memory.json blob', async () => {
    const { calls } = stubMemoryRoutes();
    const createObjectURL = vi.fn(() => 'blob:jarvis-memory');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download;
    });

    renderWithProviders(<MemoryPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Export memory/ }));

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    });
    expect(calls.some((c) => c.url.includes('/api/memory/export') && c.method === 'GET')).toBe(
      true,
    );
    expect(downloadName).toBe('jarvis-memory.json');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:jarvis-memory');
  });
});
