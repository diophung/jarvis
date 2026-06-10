import type { TaskCandidate } from '@donna/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage.js';

function makeTask(overrides: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    id: 'tc_1',
    workspaceId: 'ws_1',
    sourceItemId: 'si_1',
    title: 'Reply to the budget email',
    description: null,
    status: 'open',
    dueAt: null,
    deferredUntil: null,
    importanceScore: 80,
    urgencyScore: 70,
    effortScore: 20,
    overallScore: 86.4,
    priorityLevel: 'high',
    urgencyLevel: 'critical',
    effortLevel: 'low',
    planningCategory: 'do_now',
    signals: [{ key: 'vip_sender', label: 'From a VIP sender', weight: 30, detail: 'CEO' }],
    explanation: 'From your CEO and due soon.',
    recommendedAction: 'Reply before noon',
    projectId: null,
    peopleIds: [],
    origin: 'scoring',
    createdAt: '2026-06-09T10:00:00.000Z',
    updatedAt: '2026-06-09T10:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

type FetchCall = { url: string; method: string; body: unknown };

/** Stub fetch with a stateful in-memory tasks list; records calls. */
function stubApi(initialTasks: TaskCandidate[]) {
  let tasks = [...initialTasks];
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.startsWith('/api/tasks/') && method === 'PATCH') {
      const id = url.split('?')[0]?.split('/').pop();
      tasks = tasks.filter((t) => t.id !== id);
      return jsonResponse({ task: makeTask({ id: id ?? '', status: 'done' }) });
    }
    if (url.startsWith('/api/tasks') && method === 'GET') {
      return jsonResponse({ items: tasks });
    }
    if (url === '/api/feedback' && method === 'POST') {
      return jsonResponse({ ok: true });
    }
    if (url === '/api/tasks/rescore' && method === 'POST') {
      return jsonResponse({ scored: tasks.length });
    }
    return jsonResponse({ items: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TasksPage', () => {
  it('renders tasks grouped by planning category with a Why? signals disclosure', async () => {
    stubApi([
      makeTask(),
      makeTask({
        id: 'tc_2',
        sourceItemId: 'si_2',
        title: 'Nudge legal about the NDA',
        planningCategory: 'follow_up',
        recommendedAction: 'Ping legal again',
        signals: [{ key: 'stale', label: 'Thread went quiet', weight: 12 }],
      }),
    ]);
    renderPage();

    // Group headings in order, with counts.
    const doNow = await screen.findByRole('heading', { name: /Do Now/ });
    const followUp = screen.getByRole('heading', { name: /Follow Up/ });
    expect(doNow.textContent).toContain('1');
    expect(followUp.textContent).toContain('1');
    expect(screen.getByText('Reply to the budget email')).toBeInTheDocument();
    expect(screen.getByText('→ Reply before noon')).toBeInTheDocument();

    // Signals hidden until the Why? disclosure is opened.
    expect(screen.queryByText('From a VIP sender')).not.toBeInTheDocument();
    const whyButtons = screen.getAllByRole('button', { name: /why\?/i });
    expect(whyButtons.length).toBe(2);
    const firstWhy = whyButtons[0];
    if (!firstWhy) throw new Error('missing Why? button');
    await userEvent.click(firstWhy);
    expect(await screen.findByText('From a VIP sender')).toBeInTheDocument();
  });

  it('marks a task done via PATCH and removes the card', async () => {
    const { calls } = stubApi([makeTask()]);
    renderPage();

    const title = await screen.findByText('Reply to the budget email');
    // Scope to the card — the status filter row also has a "Done" pill.
    const card = title.closest('div.bg-surface-raised');
    if (!(card instanceof HTMLElement)) throw new Error('card not found');
    await userEvent.click(within(card).getByRole('button', { name: 'Done' }));

    await waitFor(() =>
      expect(screen.queryByText('Reply to the budget email')).not.toBeInTheDocument(),
    );
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch?.url).toBe('/api/tasks/tc_1');
    expect(patch?.body).toEqual({ status: 'done' });
  });

  it('sends feedback via POST /api/feedback and shows a thanks note', async () => {
    const { calls } = stubApi([makeTask()]);
    renderPage();

    await screen.findByText('Reply to the budget email');
    await userEvent.click(screen.getByRole('button', { name: 'Important' }));

    expect(await screen.findByText('Thanks — noted.')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/feedback');
    expect(post).toBeDefined();
    expect(post?.body).toEqual({ kind: 'important', taskCandidateId: 'tc_1' });
  });

  it('shows the calm empty state when there is nothing open', async () => {
    stubApi([]);
    renderPage();
    expect(await screen.findByText('Nothing open — enjoy the calm.')).toBeInTheDocument();
  });
});
