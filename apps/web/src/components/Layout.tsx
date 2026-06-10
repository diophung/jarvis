import type { Conversation } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CheckCircle2,
  ClipboardList,
  FileText,
  History,
  Inbox,
  ListTodo,
  MessageSquare,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useLlmStatus, useMe, usePendingApprovalsCount } from '../lib/hooks.js';

function NavItem({
  to,
  icon,
  label,
  badge,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors',
          isActive
            ? 'bg-donna-100 text-donna-900 font-medium'
            : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
        )
      }
    >
      <span className="[&>svg]:h-4 [&>svg]:w-4 shrink-0">{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="bg-donna-600 text-white text-[10px] font-semibold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

function ConversationList() {
  const { data } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.get<{ items: Conversation[] }>('/api/conversations'),
  });
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/conversations/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (id === conversationId) navigate('/');
    },
  });
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="px-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">
        Conversations
      </div>
      <div className="space-y-0.5">
        {items.slice(0, 30).map((c) => (
          <div key={c.id} className="group relative">
            <NavLink
              to={`/c/${c.id}`}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] pr-7',
                  isActive
                    ? 'bg-surface-sunken text-ink font-medium'
                    : 'text-ink-muted hover:bg-surface-sunken',
                )
              }
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{c.title || 'New conversation'}</span>
            </NavLink>
            <button
              title="Delete conversation"
              onClick={() => del.mutate(c.id)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 hidden group-hover:block text-ink-faint hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DemoModeBanner() {
  const { data } = useLlmStatus();
  const location = useLocation();
  if (!data?.demoMode) return null;
  if (location.pathname.startsWith('/settings')) return null;
  return (
    <Link
      to="/settings/providers"
      className="block bg-amber-50 border-b border-amber-200 text-amber-900 text-[13px] px-4 py-2 text-center hover:bg-amber-100"
    >
      <Sparkles className="inline h-3.5 w-3.5 mr-1.5 -mt-0.5" />
      Demo mode — no AI provider configured. Responses are mocked.{' '}
      <span className="underline font-medium">Set up a local or cloud model →</span>
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { data: approvals } = usePendingApprovalsCount();
  const qc = useQueryClient();

  const newChat = async () => {
    const res = await api.post<{ conversation: Conversation }>('/api/conversations', {});
    qc.invalidateQueries({ queryKey: ['conversations'] });
    navigate(`/c/${res.conversation.id}`);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r border-surface-border bg-surface flex flex-col">
        <div className="px-4 pt-4 pb-3 flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-donna-600 text-white flex items-center justify-center font-semibold text-sm">
            D
          </div>
          <span className="font-semibold tracking-tight">Donna</span>
        </div>
        <div className="px-3">
          <button
            onClick={newChat}
            className="w-full flex items-center gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm font-medium hover:border-donna-300 transition-colors"
          >
            <Plus className="h-4 w-4 text-donna-600" /> New chat
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          <NavItem to="/debrief" icon={<Sun />} label="Daily Debrief" />
          <NavItem to="/tasks" icon={<ListTodo />} label="Priorities" />
          <NavItem to="/search" icon={<Search />} label="Search" />
          <NavItem to="/approvals" icon={<CheckCircle2 />} label="Approvals" badge={approvals} />
          <div className="pt-3 pb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Your data
          </div>
          <NavItem to="/sources" icon={<Inbox />} label="Connected Sources" />
          <NavItem to="/files" icon={<FileText />} label="Uploaded Files" />
          <NavItem to="/digests" icon={<History />} label="Digest History" />
          <ConversationList />
        </nav>
        <div className="border-t border-surface-border px-3 py-3 space-y-0.5">
          <NavItem to="/memory" icon={<ClipboardList />} label="Memory" />
          <NavItem to="/audit" icon={<ShieldCheck />} label="Audit Log" />
          <NavItem to="/settings" icon={<Settings />} label="Settings" />
          {me && (
            <div className="flex items-center gap-2 px-2.5 pt-2">
              <div className="h-6 w-6 rounded-full bg-surface-sunken border border-surface-border flex items-center justify-center text-[11px] font-medium text-ink-muted">
                {me.user.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="text-[12px] text-ink-muted truncate">{me.user.name}</div>
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <DemoModeBanner />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
