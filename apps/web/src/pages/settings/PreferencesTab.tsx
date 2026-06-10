import type { Person, PersonImportance, Project, SourceAccount } from '@donna/core';
import { PERSON_IMPORTANCES } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Input, LoadingPane, Select, Textarea } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import {
  Field,
  prefStrings,
  prefValue,
  SettingsSection,
  TagEditor,
  ToggleChips,
  usePreferences,
  useSetPreference,
} from './shared.js';

const IMPORTANCE_OPTIONS = PERSON_IMPORTANCES.map((v) => ({ value: v, label: v }));
const PROJECT_PRIORITIES = ['high', 'normal', 'low'] as const;
const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;

function PeopleSection() {
  const { data: prefs } = usePreferences();
  const setPref = useSetPreference();
  const qc = useQueryClient();
  const { data: people, isLoading } = useQuery({
    queryKey: ['people'],
    queryFn: () => api.get<{ items: Person[] }>('/api/people'),
  });
  const patchPerson = useMutation({
    mutationFn: ({ id, importance }: { id: string; importance: PersonImportance }) =>
      api.patch<{ person: Person }>(`/api/people/${id}`, { importance }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['people'] }),
  });

  const vip = prefStrings(prefs?.items, 'people.vip');
  const rows = [...(people?.items ?? [])].sort((a, b) => b.interactionCount - a.interactionCount);

  return (
    <SettingsSection
      title="Important people"
      description="Donna treats VIP senders as high-importance signals."
    >
      <Field
        label="VIP email addresses"
        hint="Press Enter after each address. Mail and messages from these people rank higher."
      >
        <TagEditor
          value={vip}
          onChange={(next) => setPref.mutate({ key: 'people.vip', value: next })}
          placeholder="ceo@company.com"
          ariaLabel="Add VIP email"
        />
      </Field>

      <div className="mt-5">
        {isLoading ? (
          <LoadingPane label="Loading people…" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No people yet — Donna learns who you interact with as sources sync.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint uppercase tracking-wide">
                <th className="font-medium pb-2 pr-3">Person</th>
                <th className="font-medium pb-2 pr-3">Title</th>
                <th className="font-medium pb-2 pr-3">Importance</th>
                <th className="font-medium pb-2 text-right">Interactions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-surface-border/60">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{p.displayName}</div>
                    {p.emails[0] && <div className="text-xs text-ink-muted">{p.emails[0]}</div>}
                  </td>
                  <td className="py-2 pr-3 text-ink-muted">{p.title ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <Select
                      value={p.importance}
                      onChange={(v) =>
                        patchPerson.mutate({ id: p.id, importance: v as PersonImportance })
                      }
                      options={IMPORTANCE_OPTIONS}
                      className="py-1.5"
                    />
                  </td>
                  <td className="py-2 text-right text-ink-faint tabular-nums">
                    {p.interactionCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </SettingsSection>
  );
}

function ProjectsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ items: Project[] }>('/api/projects'),
  });
  const [newName, setNewName] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['projects'] });
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<Project>) =>
      api.patch<{ project: Project }>(`/api/projects/${id}`, body),
    onSuccess: invalidate,
  });
  const create = useMutation({
    mutationFn: (name: string) => api.post<{ project: Project }>('/api/projects', { name }),
    onSuccess: () => {
      setNewName('');
      invalidate();
    },
  });

  return (
    <SettingsSection
      title="Projects"
      description="Items that mention a project's keywords inherit its priority."
    >
      {isLoading ? (
        <LoadingPane label="Loading projects…" />
      ) : (
        <div className="space-y-3">
          {(data?.items ?? []).map((proj) => (
            <div
              key={proj.id}
              className="rounded-lg border border-surface-border p-3 flex flex-col gap-2.5"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-sm truncate">{proj.name}</span>
                  <Badge tone={proj.status === 'active' ? 'green' : 'neutral'}>{proj.status}</Badge>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Select
                    value={proj.priority}
                    onChange={(v) =>
                      patch.mutate({ id: proj.id, priority: v as Project['priority'] })
                    }
                    options={PROJECT_PRIORITIES.map((p) => ({ value: p, label: `${p} priority` }))}
                    className="py-1.5"
                  />
                  <Select
                    value={proj.status}
                    onChange={(v) => patch.mutate({ id: proj.id, status: v as Project['status'] })}
                    options={PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
                    className="py-1.5"
                  />
                </div>
              </div>
              <Field label="Keywords" hint="Donna links items mentioning these words to this project.">
                <TagEditor
                  value={proj.keywords}
                  onChange={(next) => patch.mutate({ id: proj.id, keywords: next })}
                  placeholder="launch, q3-roadmap"
                  ariaLabel={`Add keyword to ${proj.name}`}
                />
              </Field>
            </div>
          ))}
          {(data?.items ?? []).length === 0 && (
            <p className="text-sm text-ink-muted">No projects yet.</p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New project name"
              className="max-w-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) create.mutate(newName.trim());
              }}
            />
            <Button
              onClick={() => create.mutate(newName.trim())}
              disabled={!newName.trim()}
              loading={create.isPending}
            >
              <Plus className="h-4 w-4" /> Add project
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function TopicsSection() {
  const { data: prefs } = usePreferences();
  const setPref = useSetPreference();
  return (
    <SettingsSection
      title="Topics"
      description="Steer prioritization toward what matters and away from noise."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Prioritize" hint="Items about these topics get a boost.">
          <TagEditor
            value={prefStrings(prefs?.items, 'topics.prioritize')}
            onChange={(next) => setPref.mutate({ key: 'topics.prioritize', value: next })}
            placeholder="security, hiring"
            ariaLabel="Add prioritized topic"
          />
        </Field>
        <Field label="Ignore" hint="Items about these topics are pushed down.">
          <TagEditor
            value={prefStrings(prefs?.items, 'topics.ignore')}
            onChange={(next) => setPref.mutate({ key: 'topics.ignore', value: next })}
            placeholder="newsletters, social"
            ariaLabel="Add ignored topic"
          />
        </Field>
      </div>
    </SettingsSection>
  );
}

function SourcesSection() {
  const { data: prefs } = usePreferences();
  const setPref = useSetPreference();
  const { data: accounts } = useQuery({
    queryKey: ['source-accounts'],
    queryFn: () => api.get<{ items: SourceAccount[] }>('/api/sources/accounts'),
  });
  const providers = [...new Set((accounts?.items ?? []).map((a) => a.provider))];
  const options = providers.map((p) => ({ value: p, label: p }));
  const toggle = (key: string) => (provider: string) => {
    const current = prefStrings(prefs?.items, key);
    const next = current.includes(provider)
      ? current.filter((p) => p !== provider)
      : [...current, provider];
    setPref.mutate({ key, value: next });
  };

  return (
    <SettingsSection
      title="Sources"
      description="Weight whole sources up or down across all of Donna's ranking."
    >
      {providers.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No connected sources yet — connect one under Connected Sources first.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-[13px] font-medium mb-1.5">Prioritize</div>
            <ToggleChips
              options={options}
              selected={prefStrings(prefs?.items, 'sources.prioritize')}
              onToggle={toggle('sources.prioritize')}
            />
          </div>
          <div>
            <div className="text-[13px] font-medium mb-1.5">Ignore</div>
            <ToggleChips
              options={options}
              selected={prefStrings(prefs?.items, 'sources.ignore')}
              onToggle={toggle('sources.ignore')}
            />
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function WorkingStyleSection() {
  const { data: prefs } = usePreferences();
  const setPref = useSetPreference();
  const qc = useQueryClient();
  const wh = prefValue(prefs?.items, 'workingHours') as
    | { start?: string; end?: string }
    | undefined;
  const start = wh?.start ?? '09:00';
  const end = wh?.end ?? '17:00';
  // The assistant reads response style from the app settings store, not
  // user preferences — see GET/PUT /api/settings ('assistant.responseStyle').
  const { data: settingsData } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => api.get<{ settings: Record<string, unknown> }>('/api/settings'),
  });
  const storedStyle = settingsData?.settings['assistant.responseStyle'];
  const responseStyle = typeof storedStyle === 'string' ? storedStyle : 'concise';
  const setResponseStyle = useMutation({
    mutationFn: (value: string) => api.put('/api/settings/assistant.responseStyle', { value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app-settings'] }),
  });
  const serverPlanning = (prefValue(prefs?.items, 'planning.style') as string) ?? '';
  const [planningDraft, setPlanningDraft] = useState<string | null>(null);
  const planning = planningDraft ?? serverPlanning;

  return (
    <>
      <SettingsSection
        title="Working hours"
        description="Donna schedules debriefs and judges urgency around your day."
      >
        <div className="flex items-end gap-3">
          <Field label="Start">
            <Input
              type="time"
              value={start}
              onChange={(e) =>
                setPref.mutate({ key: 'workingHours', value: { start: e.target.value, end } })
              }
              className="w-32"
            />
          </Field>
          <Field label="End">
            <Input
              type="time"
              value={end}
              onChange={(e) =>
                setPref.mutate({ key: 'workingHours', value: { start, end: e.target.value } })
              }
              className="w-32"
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection title="Assistant style" description="How Donna writes and plans for you.">
        <div className="space-y-4 max-w-xl">
          <Field label="Response style">
            <Select
              value={responseStyle}
              onChange={(v) => setResponseStyle.mutate(v)}
              options={[
                { value: 'concise', label: 'Concise — short, to the point' },
                { value: 'detailed', label: 'Detailed — thorough explanations' },
              ]}
            />
          </Field>
          <Field
            label="Planning style"
            hint="Free text — e.g. “Deep work mornings, meetings after 2pm, never schedule over lunch.”"
          >
            <Textarea
              rows={3}
              value={planning}
              onChange={(e) => setPlanningDraft(e.target.value)}
              placeholder="Tell Donna how you like your day planned…"
            />
          </Field>
          <Button
            size="sm"
            disabled={planningDraft === null || planningDraft === serverPlanning}
            onClick={() => {
              setPref.mutate(
                { key: 'planning.style', value: planning },
                { onSuccess: () => setPlanningDraft(null) },
              );
            }}
          >
            Save planning style
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}

export function PreferencesTab() {
  const { isLoading } = usePreferences();
  if (isLoading) return <LoadingPane label="Loading preferences…" />;
  return (
    <div className="space-y-5">
      <PeopleSection />
      <ProjectsSection />
      <TopicsSection />
      <SourcesSection />
      <WorkingStyleSection />
    </div>
  );
}
