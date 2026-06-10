import clsx from 'clsx';
import {
  ArrowUpRight,
  Brain,
  CalendarClock,
  CheckCircle2,
  Container,
  Cpu,
  Inbox,
  Lock,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router-dom';
import { PageHeader } from '../components/ui.js';
import { DeploymentTab } from './settings/DeploymentTab.js';
import { PermissionsTab } from './settings/PermissionsTab.js';
import { PreferencesTab } from './settings/PreferencesTab.js';
import { ProfileTab } from './settings/ProfileTab.js';
import { ProvidersTab } from './settings/ProvidersTab.js';
import { ScheduleTab } from './settings/ScheduleTab.js';
import { SecurityTab } from './settings/SecurityTab.js';

type RailEntry =
  | { kind: 'tab'; id: string; label: string; icon: ReactNode; render: () => ReactNode }
  | { kind: 'link'; to: string; label: string; icon: ReactNode };

/** Rail entries in display order. Links jump to their full pages. */
const RAIL: RailEntry[] = [
  { kind: 'tab', id: 'profile', label: 'Profile', icon: <UserRound />, render: () => <ProfileTab /> },
  {
    kind: 'tab',
    id: 'preferences',
    label: 'Preferences',
    icon: <SlidersHorizontal />,
    render: () => <PreferencesTab />,
  },
  { kind: 'link', to: '/sources', label: 'Connected Sources', icon: <Inbox /> },
  { kind: 'tab', id: 'providers', label: 'AI Providers', icon: <Cpu />, render: () => <ProvidersTab /> },
  {
    kind: 'tab',
    id: 'permissions',
    label: 'Permissions',
    icon: <ShieldCheck />,
    render: () => <PermissionsTab />,
  },
  { kind: 'link', to: '/approvals', label: 'Approvals', icon: <CheckCircle2 /> },
  { kind: 'link', to: '/memory', label: 'Memory', icon: <Brain /> },
  {
    kind: 'tab',
    id: 'schedule',
    label: 'Digest Schedule',
    icon: <CalendarClock />,
    render: () => <ScheduleTab />,
  },
  { kind: 'tab', id: 'security', label: 'Account & security', icon: <Lock />, render: () => <SecurityTab /> },
  { kind: 'link', to: '/audit', label: 'Audit Log', icon: <ScrollText /> },
  {
    kind: 'tab',
    id: 'deployment',
    label: 'Deployment',
    icon: <Container />,
    render: () => <DeploymentTab />,
  },
];

const TABS = RAIL.filter((e): e is Extract<RailEntry, { kind: 'tab' }> => e.kind === 'tab');

const railItemClass = (active: boolean) =>
  clsx(
    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors w-full',
    active
      ? 'bg-donna-100 text-donna-900 font-medium'
      : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
  );

export function SettingsPage() {
  const { tab } = useParams<{ tab: string }>();
  const activeId = tab ?? 'profile';
  const active = TABS.find((t) => t.id === activeId);

  // Unknown tab in the URL — send the user somewhere real.
  if (!active) return <Navigate to="/settings/profile" replace />;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <PageHeader title="Settings" subtitle="Your data, your models, your rules." />
      <div className="flex flex-col md:flex-row gap-8 items-start">
        <nav
          aria-label="Settings sections"
          className="w-full md:w-52 shrink-0 md:sticky md:top-8 space-y-0.5"
        >
          {RAIL.map((entry) =>
            entry.kind === 'tab' ? (
              <NavLink
                key={entry.id}
                to={`/settings/${entry.id}`}
                className={() => railItemClass(entry.id === activeId)}
              >
                <span className="[&>svg]:h-4 [&>svg]:w-4 shrink-0">{entry.icon}</span>
                <span className="truncate">{entry.label}</span>
              </NavLink>
            ) : (
              <Link key={entry.to} to={entry.to} className={railItemClass(false)}>
                <span className="[&>svg]:h-4 [&>svg]:w-4 shrink-0">{entry.icon}</span>
                <span className="truncate flex-1">{entry.label}</span>
                <ArrowUpRight className="h-3.5 w-3.5 text-ink-faint" />
              </Link>
            ),
          )}
        </nav>
        <section className="flex-1 min-w-0 w-full">{active.render()}</section>
      </div>
    </div>
  );
}
