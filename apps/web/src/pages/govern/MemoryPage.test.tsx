import type { MemoryEntry } from '@donna/core';
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
    expect(screen.getByText('you told Donna')).toBeInTheDocument();
    expect(screen.getByText('inferred · 72% sure')).toBeInTheDocument();
    expect(
      screen.getByText('When off, Donna stores and uses nothing new about you.'),
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

  it('exports memory as a downloadable donna-memory.json blob', async () => {
    const { calls } = stubMemoryRoutes();
    const createObjectURL = vi.fn(() => 'blob:donna-memory');
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
    expect(downloadName).toBe('donna-memory.json');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:donna-memory');
  });
});
