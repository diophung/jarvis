import type {
  Citation,
  Conversation,
  FeedbackKind,
  Message,
  SuggestedAction,
  UserPreference,
} from '@donna/core';
import { FEEDBACK_KINDS } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import {
  AlertCircle,
  ArrowUp,
  Ban,
  CalendarClock,
  Check,
  Clock,
  ExternalLink,
  EyeOff,
  Flag,
  HelpCircle,
  History,
  Mail,
  PenLine,
  Plus,
  RotateCcw,
  ShieldAlert,
  Square,
  Star,
  Sun,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CitationChips, SourceItemModal } from '../components/domain.js';
import { Button, LoadingPane, Markdown } from '../components/ui.js';
import { api, postSse } from '../lib/api.js';
import { useMe } from '../lib/hooks.js';

// ---------- helpers ----------

let seq = 0;
const uid = () => `local-${Date.now().toString(36)}-${++seq}`;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function isFeedbackKind(v: unknown): v is FeedbackKind {
  return typeof v === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(v);
}

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  return 'Good evening';
}

const SUGGESTED_PROMPTS: { prompt: string; icon: LucideIcon }[] = [
  { prompt: 'What needs my attention today?', icon: Sun },
  { prompt: 'What should I prepare before my next meeting?', icon: CalendarClock },
  { prompt: 'Summarize unread emails from important people', icon: Mail },
  { prompt: 'What tasks are blocked?', icon: Ban },
  { prompt: 'What did I miss last week?', icon: History },
  { prompt: 'Which items can I safely ignore?', icon: EyeOff },
];

const ACTION_ICONS: Record<SuggestedAction['type'], LucideIcon> = {
  mark_done: Check,
  defer: Clock,
  create_draft: PenLine,
  create_task: Plus,
  schedule_follow_up: CalendarClock,
  open_source: ExternalLink,
  ask_why: HelpCircle,
  change_priority: Flag,
  ignore_similar: EyeOff,
  add_preference: Star,
};

// ---------- page ----------

export function ChatPage() {
  const { conversationId } = useParams();
  if (!conversationId) return <Hero />;
  return <ConversationView key={conversationId} conversationId={conversationId} />;
}

// ---------- hero (no conversation yet) ----------

function Hero() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const firstName = me?.user.name.split(' ')[0];

  const create = useMutation({
    mutationFn: async (prompt: string) => {
      const res = await api.post<{ conversation: Conversation }>('/api/conversations', {});
      return { conversation: res.conversation, prompt };
    },
    onSuccess: ({ conversation, prompt }) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      navigate(`/c/${conversation.id}`, { state: { initialPrompt: prompt } });
    },
  });

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto flex items-center justify-center px-4">
        <div className="max-w-chat w-full text-center py-10">
          <div className="mx-auto h-12 w-12 rounded-2xl bg-donna-600 text-white flex items-center justify-center font-semibold text-xl shadow-sm">
            D
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">
            {greetingForNow()}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-1.5 text-ink-muted">What needs your attention today?</p>
          <div className="mt-8 grid gap-2 sm:grid-cols-2 text-left">
            {SUGGESTED_PROMPTS.map(({ prompt, icon: Icon }) => (
              <button
                key={prompt}
                disabled={create.isPending}
                onClick={() => create.mutate(prompt)}
                className={clsx(
                  'flex items-center gap-2.5 rounded-xl border border-surface-border bg-surface-raised px-3.5 py-2.5',
                  'text-[13.5px] text-ink-muted text-left transition-colors',
                  'hover:border-donna-300 hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                <Icon className="h-4 w-4 text-donna-500 shrink-0" />
                {prompt}
              </button>
            ))}
          </div>
          {create.isError && (
            <p className="mt-4 text-sm text-red-700">
              Couldn’t start a conversation. Please try again.
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4">
        <div className="max-w-chat mx-auto">
          <Composer
            onSend={(text) => create.mutate(text)}
            disabled={create.isPending}
            autoFocus
          />
        </div>
      </div>
    </div>
  );
}

// ---------- conversation ----------

type ChatEntry =
  | { kind: 'message'; localId: string; message: Message }
  | { kind: 'approval'; localId: string; approvalId: string };

interface StreamError {
  message: string;
  retryText: string;
}

function ConversationView({ conversationId }: { conversationId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const initialPrompt = (location.state as { initialPrompt?: string } | null)?.initialPrompt;
  const hadInitialPromptRef = useRef(Boolean(initialPrompt));
  const sentInitialRef = useRef(false);
  /** Once the user sends anything this mount, local state is authoritative. */
  const dirtyRef = useRef(false);

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamCitations, setStreamCitations] = useState<Citation[]>([]);
  const [error, setError] = useState<StreamError | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);

  const streamTextRef = useRef('');
  const streamCitationsRef = useRef<Citation[]>([]);
  const streamActionsRef = useRef<SuggestedAction[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // History: fetched on mount; ignored once the user has interacted this session.
  const { data: convData, isLoading } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () =>
      api.get<{ conversation: Conversation; messages: Message[] }>(
        `/api/conversations/${conversationId}`,
      ),
    enabled: !hadInitialPromptRef.current,
    staleTime: Infinity,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (dirtyRef.current || !convData) return;
    setEntries(
      convData.messages.map((m) => ({ kind: 'message' as const, localId: m.id, message: m })),
    );
  }, [convData]);

  // Auto-dismiss the inline toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the latest content in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [entries.length, streamText, streaming]);

  const appendEntry = (entry: ChatEntry) => setEntries((prev) => [...prev, entry]);

  const clearStream = () => {
    streamTextRef.current = '';
    streamCitationsRef.current = [];
    streamActionsRef.current = [];
    setStreamText('');
    setStreamCitations([]);
  };

  const makeLocalMessage = (role: 'user' | 'assistant', content: string): Message => ({
    id: uid(),
    conversationId,
    workspaceId: '',
    role,
    content,
    citations: role === 'assistant' ? streamCitationsRef.current : [],
    suggestedActions: role === 'assistant' ? streamActionsRef.current : [],
    status: 'complete',
    modelUsed: null,
    llmCallId: null,
    error: null,
    createdAt: new Date().toISOString(),
  });

  async function stream(text: string) {
    if (abortRef.current) return;
    setError(null);
    setStreaming(true);
    clearStream();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let finalized = false;
    try {
      await postSse(
        `/api/conversations/${conversationId}/messages`,
        { content: text },
        {
          delta: (d) => {
            if (typeof d?.text === 'string') {
              streamTextRef.current += d.text;
              setStreamText(streamTextRef.current);
            }
          },
          citations: (d) => {
            const c: Citation[] = Array.isArray(d?.citations) ? d.citations : [];
            streamCitationsRef.current = c;
            setStreamCitations(c);
          },
          actions: (d) => {
            streamActionsRef.current = Array.isArray(d?.actions) ? d.actions : [];
          },
          approval_created: (d) => {
            const approvalId = str(d?.approvalId);
            if (approvalId) appendEntry({ kind: 'approval', localId: uid(), approvalId });
          },
          message: (d) => {
            const msg = d?.message as Message | undefined;
            if (!msg) return;
            finalized = true;
            appendEntry({
              kind: 'message',
              localId: msg.id || uid(),
              message: {
                ...msg,
                citations: msg.citations?.length ? msg.citations : streamCitationsRef.current,
                suggestedActions: msg.suggestedActions?.length
                  ? msg.suggestedActions
                  : streamActionsRef.current,
              },
            });
            clearStream();
            // Title may have been generated server-side.
            void qc.invalidateQueries({ queryKey: ['conversations'] });
          },
          error: (d) => {
            finalized = true;
            const m =
              typeof d?.error === 'string'
                ? d.error
                : (str(d?.error?.message) ?? 'Something went wrong while answering.');
            setError({ message: m, retryText: text });
            clearStream();
          },
        },
        ctrl.signal,
      );
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      if (!finalized && !aborted) {
        finalized = true;
        setError({
          message: err instanceof Error ? err.message : 'Connection lost.',
          retryText: text,
        });
        clearStream();
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
    // Stream ended without a persisted message (e.g. user pressed Stop):
    // keep whatever partial answer we have as a local assistant message.
    if (!finalized) {
      if (streamTextRef.current.trim()) {
        const partial = makeLocalMessage('assistant', streamTextRef.current);
        appendEntry({ kind: 'message', localId: partial.id, message: partial });
      }
      clearStream();
    }
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t || abortRef.current) return;
    dirtyRef.current = true;
    const userMsg = makeLocalMessage('user', t);
    appendEntry({ kind: 'message', localId: userMsg.id, message: userMsg });
    await stream(t);
  }

  const stop = () => abortRef.current?.abort();

  // A prompt handed over from the hero page: send it once, then clear the
  // navigation state so a refresh doesn't re-send it.
  useEffect(() => {
    if (!initialPrompt || sentInitialRef.current) return;
    sentInitialRef.current = true;
    dirtyRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    void send(initialPrompt);
  }, []);

  // ---------- suggested actions ----------

  const act = useMutation({
    mutationFn: async (action: SuggestedAction): Promise<string> => {
      const p = action.payload ?? {};
      const taskId = str(p.taskCandidateId) ?? str(p.taskId);
      const sourceItemId = str(p.sourceItemId) ?? str(p.itemId);
      const digestItemId = str(p.digestItemId);
      const title = str(p.title);
      switch (action.type) {
        case 'mark_done':
          if (taskId) await api.patch(`/api/tasks/${taskId}`, { status: 'done' });
          else await api.post('/api/feedback', { kind: 'done', sourceItemId, digestItemId });
          return 'Marked as done';
        case 'defer':
          if (taskId) await api.patch(`/api/tasks/${taskId}`, { status: 'deferred' });
          else await api.post('/api/feedback', { kind: 'deferred', sourceItemId, digestItemId });
          return 'Deferred';
        case 'change_priority':
          await api.post('/api/feedback', {
            kind: isFeedbackKind(p.kind) ? p.kind : 'important',
            sourceItemId,
            taskCandidateId: taskId,
            digestItemId,
            note: str(p.note),
          });
          return 'Priority feedback recorded';
        case 'add_preference': {
          // The assistant emits { key: 'people.vip', person } — append to the
          // preference list. Payloads carrying feedback refs fall through to
          // the feedback endpoint.
          const prefKey = str(p.key);
          const person = str(p.person);
          if (prefKey && person) {
            const prefs = await api.get<{ items: UserPreference[] }>('/api/preferences');
            const current = prefs.items.find((it) => it.key === prefKey)?.value;
            const list = Array.isArray(current)
              ? current.filter((x): x is string => typeof x === 'string')
              : [];
            if (!list.includes(person)) {
              await api.put(`/api/preferences/${encodeURIComponent(prefKey)}`, {
                value: [...list, person],
              });
            }
            return 'Preference saved';
          }
          await api.post('/api/feedback', {
            kind: isFeedbackKind(p.kind) ? p.kind : 'more_like_this',
            sourceItemId,
            taskCandidateId: taskId,
            digestItemId,
            note: str(p.note) ?? str(p.preference),
          });
          return 'Preference saved';
        }
        case 'ignore_similar':
          await api.post('/api/feedback', {
            kind: 'not_important',
            sourceItemId,
            taskCandidateId: taskId,
            digestItemId,
            note: str(p.note) ?? 'Ignore similar items',
          });
          return 'Donna will deprioritize similar items';
        default:
          // create_task, create_draft, schedule_follow_up — recorded as feedback.
          await api.post('/api/feedback', {
            kind: 'important',
            sourceItemId,
            taskCandidateId: taskId,
            digestItemId,
            note: `${action.label}${title ? `: ${title}` : ''}`,
          });
          return 'Noted — Donna will follow up';
      }
    },
    onSuccess: (confirmation) => {
      setToast(confirmation);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (e) => setToast(e instanceof Error ? e.message : 'That action failed'),
  });

  const runAction = (action: SuggestedAction) => {
    const p = action.payload ?? {};
    if (action.type === 'open_source') {
      const sid = str(p.sourceItemId) ?? str(p.itemId) ?? str(p.refId) ?? str(p.id);
      if (sid) setOpenSourceId(sid);
      return;
    }
    if (action.type === 'ask_why') {
      const title = str(p.title);
      void send(title ? `Why does "${title}" matter?` : 'Why does this matter?');
      return;
    }
    act.mutate(action);
  };

  // ---------- render ----------

  const lastAssistantId = [...entries]
    .reverse()
    .find((e) => e.kind === 'message' && e.message.role === 'assistant')?.localId;

  const showHistoryLoading =
    isLoading && entries.length === 0 && !streaming && !hadInitialPromptRef.current;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-chat mx-auto px-4 py-8 space-y-6">
          {showHistoryLoading && <LoadingPane label="Loading conversation…" />}
          {entries.map((entry) => {
            if (entry.kind === 'approval') {
              return <ApprovalNotice key={entry.localId} />;
            }
            const m = entry.message;
            if (m.role === 'user') {
              return (
                <div key={entry.localId} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-sunken border border-surface-border/60 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                    {m.content}
                  </div>
                </div>
              );
            }
            const showActions =
              entry.localId === lastAssistantId && !streaming && m.suggestedActions.length > 0;
            return (
              <div key={entry.localId}>
                <Markdown>{m.content}</Markdown>
                <CitationChips citations={m.citations} />
                {showActions && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {m.suggestedActions.map((a, i) => {
                      const Icon = ACTION_ICONS[a.type] ?? Check;
                      return (
                        <button
                          key={`${a.type}-${i}`}
                          disabled={act.isPending}
                          onClick={() => runAction(a)}
                          className={clsx(
                            'inline-flex items-center gap-1.5 rounded-full border border-surface-border bg-surface-raised',
                            'px-3 py-1.5 text-[12.5px] text-ink-muted transition-colors',
                            'hover:border-donna-300 hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed',
                          )}
                        >
                          <Icon className="h-3.5 w-3.5 text-donna-600" />
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {streaming && (
            <div>
              {streamText ? (
                <div>
                  <Markdown>{streamText}</Markdown>
                  <span
                    aria-hidden
                    className="ml-0.5 inline-block h-4 w-[7px] rounded-[2px] bg-donna-400 animate-pulse align-middle"
                  />
                </div>
              ) : (
                <p className="text-sm text-ink-faint animate-pulse">Thinking…</p>
              )}
              {streamCitations.length > 0 && <CitationChips citations={streamCitations} />}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="flex-1">{error.message}</div>
              <Button size="sm" variant="secondary" onClick={() => void stream(error.retryText)}>
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4">
        <div className="max-w-chat mx-auto">
          {toast && (
            <div className="pointer-events-none flex justify-center pb-2">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-ink text-surface px-3 py-1.5 text-[12px] shadow-md">
                <Check className="h-3.5 w-3.5" />
                {toast}
              </div>
            </div>
          )}
          <Composer onSend={(t) => void send(t)} streaming={streaming} onStop={stop} autoFocus />
        </div>
      </div>

      <SourceItemModal itemId={openSourceId} onClose={() => setOpenSourceId(null)} />
    </div>
  );
}

// ---------- pieces ----------

function ApprovalNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
      <div>
        Donna needs your approval for this action.{' '}
        <Link to="/approvals" className="underline font-medium hover:text-amber-950">
          Review in Approvals
        </Link>
      </div>
    </div>
  );
}

function Composer({
  onSend,
  streaming,
  onStop,
  disabled,
  autoFocus,
}: {
  onSend: (text: string) => void;
  streaming?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState('');
  const rows = Math.min(8, Math.max(1, value.split('\n').length));
  const canSend = !streaming && !disabled && value.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    const text = value.trim();
    setValue('');
    onSend(text);
  };

  return (
    <div>
      <div className="flex items-end gap-2 rounded-2xl border border-surface-border bg-surface-raised px-3 py-2 shadow-sm transition-colors focus-within:border-donna-400">
        <textarea
          rows={rows}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Message Donna…"
          aria-label="Message Donna"
          className="flex-1 resize-none bg-transparent text-[15px] leading-6 py-1 placeholder:text-ink-faint focus:outline-none max-h-48 overflow-y-auto"
        />
        {streaming ? (
          <button
            onClick={onStop}
            title="Stop generating"
            aria-label="Stop generating"
            className="h-8 w-8 shrink-0 rounded-full bg-ink text-white flex items-center justify-center hover:bg-ink/80 transition-colors"
          >
            <Square className="h-3 w-3" fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!canSend}
            title="Send"
            aria-label="Send message"
            className="h-8 w-8 shrink-0 rounded-full bg-donna-600 text-white flex items-center justify-center hover:bg-donna-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="text-center text-[11.5px] text-ink-faint mt-2">
        Donna can read your connected sources. External actions always ask first.
      </p>
    </div>
  );
}
