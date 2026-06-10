import type { CapabilityDef } from '@donna/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProviderPublic } from './settings/shared.js';
import { SettingsPage } from './SettingsPage.js';

const ISO = new Date('2026-06-01T08:00:00Z').toISOString();

const me = {
  user: {
    id: 'u-1',
    email: 'donna@example.com',
    name: 'Donna User',
    passwordHash: null,
    role: 'owner',
    createdAt: ISO,
    updatedAt: ISO,
  },
  workspace: { id: 'ws-1', ownerUserId: 'u-1', name: 'Donna', createdAt: ISO, updatedAt: ISO },
  authMode: 'local',
};

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
      if (url === '/api/llm/providers' && method === 'GET') return ok({ items: [provider] });
      if (url === '/api/llm/providers' && method === 'POST') {
        return ok({ provider: { ...provider, id: 'prov-new' } });
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
      expect(post?.body).toMatchObject({
        name: 'Ollama',
        kind: 'openai_compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.1:8b',
        isLocal: 1,
      });
    });
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

  it('saves a digest schedule preset as its cron expression', async () => {
    renderAt('/settings/schedule');
    const select = await screen.findByRole('combobox');
    await userEvent.selectOptions(select, '0 8 * * *');
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/digests/schedule');
      expect(put?.body).toEqual({ cron: '0 8 * * *', enabled: true });
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
});
