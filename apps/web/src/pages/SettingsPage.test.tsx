import type { CapabilityDef } from '@donna/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProviderPublic } from './settings/shared.js';
import { SettingsPage } from './SettingsPage.js';

const ISO = new Date('2026-06-01T08:00:00Z').toISOString();

const me = {
  user: {
    id: 'u-1',
    email: 'donna@example.com',
    name: 'Donna User',
    hasPassword: true,
    role: 'owner',
    emailVerified: false,
    avatarUrl: null,
    lastLoginAt: ISO,
    createdAt: ISO,
    updatedAt: ISO,
  },
  workspace: { id: 'ws-1', ownerUserId: 'u-1', name: 'Donna', createdAt: ISO, updatedAt: ISO },
  authMode: 'local',
};

const authAccount = {
  id: 'aa-1',
  userId: 'u-1',
  provider: 'google',
  providerAccountId: 'google-sub-1',
  email: 'donna@gmail.com',
  emailVerified: true,
  displayName: 'Donna G',
  avatarUrl: null,
  lastLoginAt: ISO,
  createdAt: ISO,
  updatedAt: ISO,
};

const sessions = [
  {
    id: 'sess-current',
    createdAt: ISO,
    lastSeenAt: ISO,
    userAgent: 'TestBrowser/1.0 (Macintosh)',
    ip: '127.0.0.1',
    current: true,
  },
  {
    id: 'sess-old',
    createdAt: ISO,
    lastSeenAt: ISO,
    userAgent: 'OtherBrowser/2.0 (Windows NT)',
    ip: '10.0.0.2',
    current: false,
  },
];

const provider: LlmProviderPublic = {
  id: 'prov-1',
  workspaceId: 'ws-1',
  name: 'Ollama',
  kind: 'openai_compatible',
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.1:8b',
  apiKeyEnv: null,
  hasStoredKey: false,
  apiKeyMasked: null,
  temperature: null,
  maxTokens: null,
  timeoutMs: null,
  extraHeaders: {},
  enabled: 1,
  isLocal: 1,
  supportsEmbeddings: 0,
  embeddingModel: null,
  createdAt: ISO,
  updatedAt: ISO,
};

const catalog: CapabilityDef[] = [
  {
    id: 'source.read',
    label: 'Read connected data',
    description: 'Read emails, chats, calendar events, and files from connected sources.',
    group: 'read',
    risk: 'safe',
    defaultEffect: 'auto_approve',
    externallyVisible: false,
  },
  {
    id: 'email.send',
    label: 'Send emails on your behalf',
    description: 'Send email messages that other people will see.',
    group: 'create_external',
    risk: 'high',
    defaultEffect: 'require_approval',
    externallyVisible: true,
  },
];

const emptyRoutes = {
  routes: { chat: null, summarization: null, digest: null, classification: null, embedding: null },
};
const emptyStatus = {
  demoMode: true,
  tasks: { chat: null, summarization: null, digest: null, classification: null, embedding: null },
};

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
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, method, body });

      if (url === '/api/me') return ok(me);
      if (url === '/api/auth/methods') {
        return ok({
          authMode: 'password',
          signupEnabled: false,
          oauthProviders: ['google', 'facebook', 'apple'],
        });
      }
      if (url === '/api/auth/accounts' && method === 'GET') return ok({ items: [authAccount] });
      if (url.startsWith('/api/auth/accounts/') && method === 'DELETE') return ok({ ok: true });
      if (url === '/api/auth/sessions' && method === 'GET') return ok({ items: sessions });
      if (url === '/api/auth/sessions' && method === 'DELETE') {
        return ok({ ok: true, revoked: 3 });
      }
      if (url.startsWith('/api/auth/sessions/') && method === 'DELETE') return ok({ ok: true });
      if (url === '/api/auth/password' && method === 'POST') return ok({ ok: true });
      if (url === '/api/llm/providers' && method === 'GET') return ok({ items: [provider] });
      if (url === '/api/llm/providers' && method === 'POST') {
        return ok({ provider: { ...provider, id: 'prov-new' } });
      }
      if (url === '/api/llm/providers/prov-1' && method === 'PATCH') {
        return ok({ provider: { ...provider, enabled: 0 } });
      }
      if (url === '/api/settings' && method === 'GET') {
        return ok({ settings: { 'assistant.responseStyle': 'detailed' } });
      }
      if (url === '/api/settings/assistant.responseStyle' && method === 'PUT') {
        return ok({ ok: true });
      }
      if (url === '/api/llm/routes') return ok(emptyRoutes);
      if (url.startsWith('/api/llm/routes/') && method === 'PUT') {
        return ok({ route: { task: 'digest' } });
      }
      if (url === '/api/llm/status') return ok(emptyStatus);
      if (url.startsWith('/api/llm/calls')) return ok({ items: [] });
      if (url === '/api/policies/catalog') return ok({ items: catalog });
      if (url === '/api/policies' && method === 'GET') return ok({ items: [] });
      if (url.startsWith('/api/policies/') && method === 'PUT') {
        return ok({ policy: { id: 'pol-1' } });
      }
      if (url === '/api/digests/schedule' && method === 'GET') {
        return ok({ schedule: { cron: '0 7 * * *', enabled: true } });
      }
      if (url === '/api/digests/schedule' && method === 'PUT') {
        return ok({ schedule: body });
      }
      return ok({ items: [] });
    }),
  );
}

/** Exposes the router location so tests can assert query params get cleared. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the tab rail and navigates to the AI Providers tab', async () => {
    renderAt('/settings');
    // Defaults to the Profile tab.
    expect(await screen.findByLabelText('Name')).toHaveValue('Donna User');
    await userEvent.click(screen.getByRole('link', { name: 'AI Providers' }));
    expect(await screen.findByText('Task routing')).toBeInTheDocument();
    expect(screen.getByText(/Demo mode/)).toBeInTheDocument();
    expect(screen.getByText('Runs locally — data stays on your machine')).toBeInTheDocument();
  });

  it('prefills the add-provider form from a preset and POSTs it', async () => {
    renderAt('/settings/providers');
    await userEvent.click(await screen.findByRole('button', { name: /add provider/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Ollama (local)' }));
    expect(screen.getByLabelText(/base url/i)).toHaveValue('http://localhost:11434/v1');

    await userEvent.type(screen.getByLabelText(/whatever model id/i), 'llama3.1:8b');
    await userEvent.click(screen.getByRole('button', { name: 'Save provider' }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/llm/providers');
      expect(post).toBeTruthy();
      // isLocal / supportsEmbeddings must be real booleans — the server zod
      // schema rejects 1/0 with a 400.
      expect(post?.body).toMatchObject({
        name: 'Ollama',
        kind: 'openai_compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.1:8b',
        isLocal: true,
        supportsEmbeddings: false,
      });
    });
  });

  it('toggles a provider off with a boolean enabled PATCH', async () => {
    renderAt('/settings/providers');
    await userEvent.click(await screen.findByRole('switch', { name: 'Enabled' }));
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.method === 'PATCH' && c.url === '/api/llm/providers/prov-1',
      );
      expect(patch?.body).toEqual({ enabled: false });
    });
  });

  it('shows inline feedback when the enabled toggle PATCH fails', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/llm/providers/prov-1' && method === 'PATCH') {
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({ error: { code: 'bad_request', message: 'Invalid provider patch' } }),
          };
        }
        return base(input, init);
      }),
    );

    renderAt('/settings/providers');
    await userEvent.click(await screen.findByRole('switch', { name: 'Enabled' }));

    expect(
      await screen.findByText(/Couldn’t disable this provider — Invalid provider patch/),
    ).toBeInTheDocument();
    // The switch reflects server state, so it stays on rather than lying.
    expect(screen.getByRole('switch', { name: 'Enabled' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('reads response style from app settings and saves it via PUT /api/settings', async () => {
    renderAt('/settings/preferences');
    // Initial value comes from GET /api/settings, not /api/preferences.
    const select = await screen.findByLabelText('Response style');
    await waitFor(() => expect(select).toHaveValue('detailed'));

    await userEvent.selectOptions(select, 'concise');
    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === 'PUT' && c.url === '/api/settings/assistant.responseStyle',
      );
      expect(put?.body).toEqual({ value: 'concise' });
    });
    // It must not write to the preferences store the assistant never reads.
    expect(calls.find((c) => c.url.startsWith('/api/preferences/'))).toBeUndefined();
  });

  it('confirms before auto-approving an externally visible capability, then PUTs', async () => {
    renderAt('/settings/permissions');
    expect(await screen.findByText('Send emails on your behalf')).toBeInTheDocument();

    const row = screen.getByTestId('cap-row-email.send');
    await userEvent.selectOptions(within(row).getByRole('combobox'), 'auto_approve');

    // Confirm modal first — no PUT yet.
    expect(
      await screen.findByText(/Donna will be able to send emails on your behalf without asking/),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: 'Allow automatically' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/policies/email.send');
      expect(put?.body).toEqual({ effect: 'auto_approve' });
    });
  });

  it('saves a changed time as a daily cron expression', async () => {
    // GET seeds the editor with the default daily 7:00 (0 7 * * *).
    renderAt('/settings/schedule');
    const time = await screen.findByLabelText('Time');
    fireEvent.change(time, { target: { value: '08:00' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/digests/schedule');
      expect(put?.body).toEqual({ cron: '0 8 * * *', enabled: true });
    });
  });

  it('builds a weekly cron from the day chips', async () => {
    renderAt('/settings/schedule');
    await userEvent.click(await screen.findByRole('button', { name: 'Weekly' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mon' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fri' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/digests/schedule');
      expect(put?.body).toEqual({ cron: '0 7 * * 1,5', enabled: true });
    });
  });

  it('pauses scheduled debriefs via the on/off switch', async () => {
    renderAt('/settings/schedule');
    await userEvent.click(await screen.findByRole('switch', { name: /scheduled debriefs are on/i }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/digests/schedule');
      expect(put?.body).toEqual({ cron: '0 7 * * *', enabled: false });
    });
  });

  it('keeps a custom cron expression editable through the escape hatch', async () => {
    renderAt('/settings/schedule');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Use a custom cron expression' }),
    );
    const cron = screen.getByLabelText(/cron expression/i);
    await userEvent.clear(cron);
    await userEvent.type(cron, '15 6 * * 1-5');
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/digests/schedule');
      expect(put?.body).toEqual({ cron: '15 6 * * 1-5', enabled: true });
    });
  });

  it('routes a task to a provider via PUT /api/llm/routes/:task', async () => {
    renderAt('/settings/providers');
    const row = await screen.findByTestId('route-digest');
    await userEvent.selectOptions(within(row).getByRole('combobox'), 'prov-1');
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/llm/routes/digest');
      expect(put?.body).toEqual({ providerConfigId: 'prov-1', modelOverride: null });
    });
  });

  // ---------- Security tab (Account & security) ----------

  it('changes the password with current + new password in the POST body', async () => {
    renderAt('/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: 'Change password' }));
    await userEvent.type(screen.getByLabelText('Current password'), 'old-pw');
    await userEvent.type(screen.getByLabelText('New password'), 'new-pw-12345');
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url === '/api/auth/password');
      expect(post?.body).toEqual({ currentPassword: 'old-pw', newPassword: 'new-pw-12345' });
    });
    expect(
      await screen.findByText(/Password updated — other sessions were signed out/),
    ).toBeInTheDocument();
  });

  it('renders linked accounts with link buttons for the remaining providers', async () => {
    renderAt('/settings/security');
    expect(await screen.findByText('donna@gmail.com')).toBeInTheDocument();
    expect(screen.getByText(/Donna G/)).toBeInTheDocument();
    // Google is already linked, so only Facebook and Apple are offered.
    expect(screen.queryByRole('link', { name: 'Link Google' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Link Facebook' })).toHaveAttribute(
      'href',
      expect.stringContaining(
        `/api/auth/oauth/facebook/start?link=1&returnTo=${encodeURIComponent('/settings/security')}`,
      ),
    );
    expect(screen.getByRole('link', { name: 'Link Apple' })).toBeInTheDocument();
    // Email verification badge reflects the unverified fixture user.
    expect(screen.getByText('Unverified')).toBeInTheDocument();
  });

  it('shows friendly copy for ?linkError=already_linked and strips the param', async () => {
    renderAt('/settings/security?linkError=already_linked');
    expect(
      await screen.findByText('That account is already linked to a different user.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/settings\/security$/);
    });
  });

  it('shows generic copy for unrecognized linkError codes', async () => {
    renderAt('/settings/security?linkError=oauth_failed');
    expect(await screen.findByText('Linking failed — try again.')).toBeInTheDocument();
  });

  it('unlinks a linked account via DELETE /api/auth/accounts/:id', async () => {
    renderAt('/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink Google' }));
    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === 'DELETE' && c.url === '/api/auth/accounts/aa-1',
      );
      expect(del).toBeTruthy();
    });
  });

  it('explains the last_login_method 400 when unlink would lock the user out', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url === '/api/auth/accounts/aa-1' && method === 'DELETE') {
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
              error: { code: 'last_login_method', message: 'cannot remove last login method' },
            }),
          };
        }
        return base(input, init);
      }),
    );

    renderAt('/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink Google' }));
    expect(
      await screen.findByText('Set a password first — this is your only way to sign in.'),
    ).toBeInTheDocument();
  });

  it('lists sessions and signs out everywhere else via DELETE /api/auth/sessions', async () => {
    renderAt('/settings/security');
    expect(await screen.findByText('This device')).toBeInTheDocument();
    // Only the non-current session can be revoked individually.
    expect(screen.getAllByRole('button', { name: /^Revoke session/ })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out everywhere else' }));
    await waitFor(() => {
      const del = calls.find((c) => c.method === 'DELETE' && c.url === '/api/auth/sessions');
      expect(del).toBeTruthy();
    });
    expect(await screen.findByText(/Signed out 3 other sessions/)).toBeInTheDocument();
  });

  it('revokes a single session via DELETE /api/auth/sessions/:id', async () => {
    renderAt('/settings/security');
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke session sess-old' }));
    await waitFor(() => {
      const del = calls.find(
        (c) => c.method === 'DELETE' && c.url === '/api/auth/sessions/sess-old',
      );
      expect(del).toBeTruthy();
    });
  });
});
