import type { ConnectorRun, SourceAccount } from '@donna/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnector } from './sources/CatalogSection.js';
import { SourcesPage } from './SourcesPage.js';

const NOW = Date.now();

const account: SourceAccount = {
  id: 'acc-1',
  workspaceId: 'ws-1',
  userId: 'u-1',
  provider: 'mock-email',
  category: 'email',
  displayName: 'Demo Inbox',
  status: 'connected',
  authRef: null,
  scopes: [],
  capabilities: ['read', 'list', 'search'],
  settings: {},
  lastSyncAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
  syncCursor: null,
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  updatedAt: new Date(NOW - 3_600_000).toISOString(),
};

const run: ConnectorRun = {
  id: 'run-1',
  workspaceId: 'ws-1',
  accountId: 'acc-1',
  mode: 'incremental',
  status: 'success',
  startedAt: new Date(NOW - 5_000).toISOString(),
  completedAt: new Date(NOW - 1_000).toISOString(),
  itemsSeen: 7,
  itemsCreated: 5,
  itemsUpdated: 2,
  errorCount: 0,
  errors: [],
  cursorBefore: null,
  cursorAfter: 'cursor-2',
  log: null,
  triggeredBy: 'manual',
  createdAt: new Date(NOW - 5_000).toISOString(),
};

const catalog: CatalogConnector[] = [
  {
    provider: 'mock-email',
    category: 'email',
    label: 'Demo email',
    description: 'A realistic local inbox — no credentials needed.',
    capabilities: ['read', 'list', 'search'],
    scopes: [],
    requiredEnv: [],
    local: true,
    configured: true,
  },
  {
    provider: 'gmail',
    category: 'email',
    label: 'Gmail',
    description: 'Read-only sync of your Gmail inbox.',
    capabilities: ['read', 'list', 'search', 'send'],
    scopes: ['gmail.readonly'],
    requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    local: false,
    configured: false,
  },
];

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];

function ok(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data };
}

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, method, body });
      if (method === 'POST' && /\/api\/sources\/accounts\/[^/]+\/sync$/.test(url)) {
        return ok({ run });
      }
      if (url === '/api/sources/accounts' && method === 'GET') return ok({ items: [account] });
      if (url === '/api/sources/accounts' && method === 'POST') {
        return ok({ account: { ...account, id: 'acc-new' } });
      }
      if (url === '/api/sources/catalog') return ok({ items: catalog });
      if (url.startsWith('/api/sources/items')) return ok({ items: [] });
      if (/\/api\/sources\/accounts\/[^/]+\/runs$/.test(url)) return ok({ items: [run] });
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
        <SourcesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SourcesPage', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders connected accounts with status and last-sync time', async () => {
    renderPage();
    expect(await screen.findByText('Demo Inbox')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
  });

  it('syncs on demand and shows the returned run inline', async () => {
    renderPage();
    await screen.findByText('Demo Inbox');
    await userEvent.click(screen.getByRole('button', { name: /sync now/i }));
    expect(await screen.findByText(/5 new, 2 updated/)).toBeInTheDocument();
    const syncCall = calls.find(
      (c) => c.method === 'POST' && c.url === '/api/sources/accounts/acc-1/sync',
    );
    expect(syncCall).toBeTruthy();
    expect(syncCall?.body).toEqual({ mode: 'incremental' });
  });

  it('gates unconfigured real connectors with a disabled button and env hint', async () => {
    renderPage();
    expect(await screen.findByText('Gmail')).toBeInTheDocument();
    expect(
      screen.getByText(/Requires env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/),
    ).toBeInTheDocument();
    expect(screen.getByText(/docs\/connectors\.md/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('connects a demo source from the catalog', async () => {
    renderPage();
    await screen.findByText('Demo email');
    await userEvent.click(screen.getByRole('button', { name: /connect demo source/i }));
    await waitFor(() => {
      const connectCall = calls.find(
        (c) => c.method === 'POST' && c.url === '/api/sources/accounts',
      );
      expect(connectCall?.body).toEqual({ provider: 'mock-email' });
    });
  });
});
