import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from './ChatPage.js';

const NOW = '2026-06-10T08:00:00.000Z';

const conversation = {
  id: 'conv1',
  workspaceId: 'ws1',
  userId: 'u1',
  title: 'New conversation',
  pinned: 0,
  archived: 0,
  lastMessageAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const me = {
  user: {
    id: 'u1',
    email: 'cuong@example.com',
    name: 'Cuong Phung',
    passwordHash: null,
    role: 'owner',
    createdAt: NOW,
    updatedAt: NOW,
  },
  workspace: { id: 'ws1', ownerUserId: 'u1', name: 'Workspace', createdAt: NOW, updatedAt: NOW },
  authMode: 'local',
};

const assistantMessage = {
  id: 'm2',
  conversationId: 'conv1',
  workspaceId: 'ws1',
  role: 'assistant',
  content: 'Here is your answer.',
  citations: [
    { sourceType: 'source_item', refId: 'si1', title: 'Quarterly report email', sourceLabel: 'Gmail' },
  ],
  suggestedActions: [{ type: 'mark_done', label: 'Mark done', payload: { taskCandidateId: 'task1' } }],
  status: 'complete',
  modelUsed: null,
  llmCallId: null,
  error: null,
  createdAt: NOW,
};

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const sseFrames = [
  frame('delta', { text: 'Here is ' }),
  frame('delta', { text: 'your answer.' }),
  frame('citations', { citations: assistantMessage.citations }),
  frame('actions', { actions: assistantMessage.suggestedActions }),
  frame('message', { message: assistantMessage }),
];

function jsonRes(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function sseRes(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/me') return jsonRes(me);
    if (url === '/api/conversations' && method === 'POST') return jsonRes({ conversation });
    if (url === '/api/conversations/conv1/messages' && method === 'POST') return sseRes(sseFrames);
    if (url === '/api/conversations/conv1' && method === 'GET') {
      return jsonRes({ conversation, messages: [] });
    }
    if (url.startsWith('/api/tasks/') && method === 'PATCH') {
      return jsonRes({ task: { id: 'task1', status: 'done' } });
    }
    if (url === '/api/feedback' && method === 'POST') return jsonRes({ ok: true });
    return jsonRes({ items: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat(path = '/') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/c/:conversationId" element={<ChatPage />} />
          <Route path="/approvals" element={<div>Approvals page</div>} />
          <Route path="/memory" element={<div>Memory page</div>} />
          <Route path="/files" element={<div>Files page</div>} />
          <Route path="/digests/:digestId" element={<div>Digest page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Replace the messages SSE stream with a single final message, plus optional extra routes. */
function mockAssistantMessage(
  message: Record<string, unknown>,
  extraRoutes?: (url: string, init?: RequestInit) => Response | undefined,
) {
  const frames = [frame('message', { message })];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const extra = extraRoutes?.(url, init);
    if (extra) return extra;
    if (url === '/api/me') return jsonRes(me);
    if (url === '/api/conversations' && method === 'POST') return jsonRes({ conversation });
    if (url === '/api/conversations/conv1/messages' && method === 'POST') return sseRes(frames);
    if (url === '/api/conversations/conv1' && method === 'GET') {
      return jsonRes({ conversation, messages: [] });
    }
    if (url === '/api/feedback' && method === 'POST') return jsonRes({ ok: true });
    return jsonRes({ items: [] });
  });
}

describe('ChatPage', () => {
  it('renders the hero with greeting and six suggested prompt chips on /', () => {
    renderChat('/');
    expect(screen.getByText(/Good (morning|afternoon|evening)/)).toBeInTheDocument();
    expect(screen.getByText('What needs your attention today?')).toBeInTheDocument();
    for (const prompt of [
      'What needs my attention today?',
      'What should I prepare before my next meeting?',
      'Summarize unread emails from important people',
      'What tasks are blocked?',
      'What did I miss last week?',
      'Which items can I safely ignore?',
    ]) {
      expect(screen.getByText(prompt)).toBeInTheDocument();
    }
    expect(
      screen.getByText('Jarvis can read your connected sources. External actions always ask first.'),
    ).toBeInTheDocument();
  });

  it('creates a conversation from a chip, appends the user bubble, and streams the assistant reply', async () => {
    renderChat('/');
    fireEvent.click(screen.getByText('What tasks are blocked?'));

    // Assistant text assembled from the delta events + final persisted message.
    expect(await screen.findByText('Here is your answer.')).toBeInTheDocument();

    // Hero unmounted; the remaining match is the user bubble.
    expect(screen.queryByText('Which items can I safely ignore?')).not.toBeInTheDocument();
    expect(screen.getByText('What tasks are blocked?')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conv1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'What tasks are blocked?' }),
      }),
    );
  });

  it('renders citation chips after the citations event', async () => {
    renderChat('/');
    fireEvent.click(screen.getByText('What needs my attention today?'));
    await screen.findByText('Here is your answer.');
    expect(await screen.findByText('Quarterly report email')).toBeInTheDocument();
  });

  it('mark_done suggested action PATCHes the task and shows a confirmation', async () => {
    renderChat('/');
    fireEvent.click(screen.getByText('What tasks are blocked?'));
    await screen.findByText('Here is your answer.');

    fireEvent.click(await screen.findByRole('button', { name: /mark done/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/tasks/task1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
      );
    });
    expect(await screen.findByText('Marked as done')).toBeInTheDocument();
  });

  it('add_preference with key+person appends the person to the preference list', async () => {
    mockAssistantMessage(
      {
        ...assistantMessage,
        suggestedActions: [
          {
            type: 'add_preference',
            label: 'Treat Alice as important',
            payload: { key: 'people.vip', person: 'alice@example.com' },
          },
        ],
      },
      (url, init) => {
        const method = init?.method ?? 'GET';
        if (url === '/api/preferences' && method === 'GET') {
          return jsonRes({ items: [{ key: 'people.vip', value: ['boss@example.com'] }] });
        }
        if (url === '/api/preferences/people.vip' && method === 'PUT') {
          return jsonRes({ preference: { key: 'people.vip' } });
        }
        return undefined;
      },
    );
    renderChat('/');
    fireEvent.click(screen.getByText('What needs my attention today?'));

    fireEvent.click(await screen.findByRole('button', { name: /treat alice as important/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/preferences/people.vip',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ value: ['boss@example.com', 'alice@example.com'] }),
        }),
      );
    });
    expect(await screen.findByText('Preference saved')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/feedback', expect.anything());
  });

  it('add_preference without key+person still falls back to a feedback POST', async () => {
    mockAssistantMessage({
      ...assistantMessage,
      suggestedActions: [
        {
          type: 'add_preference',
          label: 'More like this',
          payload: { kind: 'more_like_this', taskCandidateId: 'task1' },
        },
      ],
    });
    renderChat('/');
    fireEvent.click(screen.getByText('What needs my attention today?'));

    fireEvent.click(await screen.findByRole('button', { name: /more like this/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/feedback',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ kind: 'more_like_this', taskCandidateId: 'task1' }),
        }),
      );
    });
    expect(await screen.findByText('Preference saved')).toBeInTheDocument();
  });

  it('routes memory citations to /memory and renders unknown citations as inert chips', async () => {
    mockAssistantMessage({
      ...assistantMessage,
      citations: [
        { sourceType: 'memory', refId: 'mem1', title: 'A memory citation' },
        { sourceType: 'task_candidate', refId: 'tc1', title: 'A task citation' },
      ],
      suggestedActions: [],
    });
    renderChat('/');
    fireEvent.click(screen.getByText('What needs my attention today?'));

    // Unknown source type with no url: not a dead button, just a chip.
    const taskChip = await screen.findByText('A task citation');
    expect(taskChip.closest('button')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /a memory citation/i }));
    expect(await screen.findByText('Memory page')).toBeInTheDocument();
  });

  it('routes digest citations to /digests/:id', async () => {
    mockAssistantMessage({
      ...assistantMessage,
      citations: [{ sourceType: 'digest', refId: 'dig1', title: 'A digest citation' }],
      suggestedActions: [],
    });
    renderChat('/');
    fireEvent.click(screen.getByText('What needs my attention today?'));

    fireEvent.click(await screen.findByRole('button', { name: /a digest citation/i }));
    expect(await screen.findByText('Digest page')).toBeInTheDocument();
  });

  it('routes uploaded-file citations to /files', async () => {
    mockAssistantMessage({
      ...assistantMessage,
      citations: [{ sourceType: 'uploaded_file', refId: 'file1', title: 'A file citation' }],
      suggestedActions: [],
    });
    renderChat('/');
    fireEvent.click(screen.getByText('What needs my attention today?'));

    fireEvent.click(await screen.findByRole('button', { name: /a file citation/i }));
    expect(await screen.findByText('Files page')).toBeInTheDocument();
  });
});
