import type { ConnectorRun, SourceAccount } from '@jarvis/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceAccountView } from './sources/AccountCard.js';
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
  lastError: null,
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  updatedAt: new Date(NOW - 3_600_000).toISOString(),
};

/** An OAuth-connected Gmail account whose grant has expired. */
const gmailAccount: SourceAccountView = {
  ...account,
  id: 'acc-g1',
  provider: 'gmail',
  displayName: 'Gmail',
  status: 'needs_auth',
  authKind: 'oauth',
  grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  lastError: 'invalid_grant: token has been revoked or expired',
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

const demoConnector: CatalogConnector = {
  provider: 'mock-email',
  category: 'email',
  label: 'Demo email',
  description: 'A realistic local inbox — no credentials needed.',
  capabilities: ['read', 'list', 'search'],
  scopes: [],
  requiredEnv: [],
  local: true,
  configured: true,
};

const gmailConnector: CatalogConnector = {
  provider: 'gmail',
  category: 'email',
  label: 'Gmail',
  description: 'Read-only sync of your Gmail inbox.',
  capabilities: ['read', 'list', 'search', 'send'],
  scopes: ['gmail.readonly'],
  requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  local: false,
  configured: false,
};

const catalog: CatalogConnector[] = [demoConnector, gmailConnector];

/** The same catalog once Google OAuth credentials are configured server-side. */
const oauthCatalog: CatalogConnector[] = [
  demoConnector,
  { ...gmailConnector, configured: true, oauthConnectable: true },
];

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];

function ok(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data };
}

function stubFetch(
  overrides: { accounts?: SourceAccountView[]; catalog?: CatalogConnector[] } = {},
) {
  const accountItems = overrides.accounts ?? [account];
  const catalogItems = overrides.catalog ?? catalog;
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
      if (method === 'DELETE' && /\/api\/sources\/accounts\/[^/]+$/.test(url)) {
        return ok({ ok: true });
      }
      if (url === '/api/sources/accounts' && method === 'GET') return ok({ items: accountItems });
      if (url === '/api/sources/accounts' && method === 'POST') {
        return ok({ account: { ...account, id: 'acc-new' } });
      }
      if (url === '/api/sources/catalog') return ok({ items: catalogItems });
      if (url.startsWith('/api/sources/items')) return ok({ items: [] });
      if (/\/api\/sources\/accounts\/[^/]+\/runs$/.test(url)) return ok({ items: [run] });
      return ok({ items: [] });
    }),
  );
}

/** Exposes the router location so tests can assert query params get cleared. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPage(path = '/sources') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <SourcesPage />
        <LocationProbe />
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

  it('renders a Connect with Google link for oauth-connectable catalog entries', async () => {
    stubFetch({ catalog: oauthCatalog });
    renderPage();
    const link = await screen.findByRole('link', { name: 'Connect with Google' });
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining('/api/sources/oauth/google/gmail/start?returnTo=%2Fsources'),
    );
    // What the grant allows is explained up front.
    expect(
      screen.getByText(/read message subjects, senders, and snippets/),
    ).toBeInTheDocument();
  });

  it('gates oauth-connectable entries whose env is not configured (no dead Connect button)', async () => {
    stubFetch({
      catalog: [demoConnector, { ...gmailConnector, configured: false, oauthConnectable: true }],
    });
    renderPage();
    expect(await screen.findByText('Gmail')).toBeInTheDocument();
    // No Connect-with-Google link: starting the flow without server-side
    // credentials would dead-end on a raw JSON error.
    expect(screen.queryByRole('link', { name: 'Connect with Google' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Requires env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('shows scope chips, last error, and a Reconnect link for needs_auth accounts', async () => {
    stubFetch({ accounts: [gmailAccount] });
    renderPage();
    expect(await screen.findByText('Needs reauthorization')).toBeInTheDocument();
    // Scope chips strip the googleapis prefix for display.
    expect(screen.getByText('gmail.readonly')).toBeInTheDocument();
    // Last error is truncated but fully available via the title attribute.
    expect(
      screen.getByTitle('invalid_grant: token has been revoked or expired'),
    ).toBeInTheDocument();
    const reconnect = screen.getByRole('link', { name: /reconnect/i });
    expect(reconnect).toHaveAttribute(
      'href',
      expect.stringContaining('/api/sources/oauth/google/gmail/start?returnTo=%2Fsources'),
    );
  });

  it('confirms disconnect (mentioning token revocation) and fires the DELETE', async () => {
    stubFetch({ accounts: [gmailAccount] });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('Needs reauthorization');
    await userEvent.click(screen.getByRole('button', { name: 'Options for Gmail' }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/revoked and removed/));
    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === 'DELETE' && c.url === '/api/sources/accounts/acc-g1',
      );
      expect(del).toBeTruthy();
    });
  });

  it('shows the connected banner from ?connected= and clears the query param', async () => {
    renderPage('/sources?connected=gmail');
    expect(await screen.findByText('Gmail connected — first sync started.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/sources$/);
    });
  });

  it('shows friendly copy for ?sourceError=wrong_account', async () => {
    renderPage('/sources?sourceError=wrong_account');
    expect(
      await screen.findByText(
        'Reconnect with the SAME Google account this source was originally connected with.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/sources$/);
    });
  });
});
