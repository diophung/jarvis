import type { UploadedFile } from '@jarvis/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPage } from './FilesPage.js';

const NOW = Date.now();

function makeFile(overrides: Partial<UploadedFile>): UploadedFile {
  return {
    id: 'up-1',
    workspaceId: 'ws-1',
    userId: 'u-1',
    accountId: null,
    sourceItemId: null,
    filename: 'plan.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 52_345,
    storagePath: '/data/uploads/plan.pdf',
    textExtracted: 1,
    extractionError: null,
    status: 'ready',
    sha256: null,
    createdAt: new Date(NOW - 7_200_000).toISOString(),
    updatedAt: new Date(NOW - 7_000_000).toISOString(),
    ...overrides,
  };
}

type Call = { url: string; method: string };
let calls: Call[] = [];
let items: UploadedFile[] = [];

function ok(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data };
}

function stubFetch() {
  calls = [];
  items = [makeFile({})];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/api/uploads' && method === 'POST') {
        const uploaded = makeFile({
          id: `up-${items.length + 1}`,
          filename: 'notes.txt',
          mimeType: 'text/plain',
          sizeBytes: 5,
          createdAt: new Date(NOW).toISOString(),
        });
        items = [uploaded, ...items];
        return ok({ file: uploaded });
      }
      if (url === '/api/uploads' && method === 'GET') return ok({ items });
      if (/\/api\/uploads\/[^/]+\/text$/.test(url)) return ok({ text: 'Hello extracted world' });
      if (method === 'DELETE' && /\/api\/uploads\/[^/]+$/.test(url)) {
        const id = url.split('/').pop();
        items = items.filter((f) => f.id !== id);
        return ok({ ok: true });
      }
      return ok({ items: [] });
    }),
  );
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FilesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FilesPage', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uploads a picked file to /api/uploads and shows it in the list', async () => {
    renderPage();
    await screen.findByText('plan.pdf');
    const input = screen.getByLabelText('Upload files');
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    expect((await screen.findAllByText('notes.txt')).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/uploads')).toBe(true);
    });
  });

  it('confirms before deleting and issues the DELETE request', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('plan.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Delete plan.pdf' }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/uploads/up-1')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText('plan.pdf')).not.toBeInTheDocument();
    });
  });

  it('does not delete when the confirm dialog is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByText('plan.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Delete plan.pdf' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('opens the view-text modal and fetches the extracted text', async () => {
    renderPage();
    await screen.findByText('plan.pdf');
    await userEvent.click(screen.getByRole('button', { name: /view text/i }));
    expect(await screen.findByText('Hello extracted world')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/uploads/up-1/text' && c.method === 'GET')).toBe(true);
  });
});
