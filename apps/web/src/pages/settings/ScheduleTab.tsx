import type { Digest } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CalendarClock, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input, LoadingPane, Switch } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import {
  type Frequency,
  type Recurrence,
  WEEKDAY_LABELS_SHORT,
  describeRecurrence,
  formatNextRun,
  isValidRecurrence,
  nextRun,
  parseCron,
  parseTimeInput,
  toCron,
  toTimeInput,
} from './digest-schedule.js';
import { Field, SettingsSection, ToggleChips } from './shared.js';

interface ScheduleValue {
  cron: string;
  enabled: boolean;
}

interface ScheduleResponse {
  schedule: ScheduleValue;
}

const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
];

const DAY_OPTIONS = WEEKDAY_LABELS_SHORT.map((label, i) => ({ value: String(i), label }));

export function ScheduleTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['digest-schedule'],
    queryFn: () => api.get<ScheduleResponse>('/api/digests/schedule'),
  });
  const [generated, setGenerated] = useState(false);
  const generate = useMutation({
    mutationFn: () => api.post<{ digest: Digest }>('/api/digests/generate', { kind: 'manual' }),
    onSuccess: () => {
      setGenerated(true);
      qc.invalidateQueries({ queryKey: ['digests'] });
    },
  });

  if (isLoading || !data) return <LoadingPane label="Loading schedule…" />;

  return (
    <div className="space-y-5">
      {/* Remount when the saved value changes so the editor re-seeds cleanly. */}
      <ScheduleEditor
        key={`${data.schedule.cron}|${data.schedule.enabled}`}
        saved={data.schedule}
      />

      <SettingsSection
        title="Generate one now"
        description="Don't want to wait? Build a fresh debrief from your latest data."
      >
        <div className="flex items-center gap-3">
          <Button variant="primary" loading={generate.isPending} onClick={() => generate.mutate()}>
            <Sun className="h-4 w-4" /> Generate one now
          </Button>
          {generated && (
            <Link to="/debrief" className="text-sm text-donna-700 underline underline-offset-2">
              View your debrief →
            </Link>
          )}
          {generate.isError && (
            <span className="text-sm text-red-600">{(generate.error as Error).message}</span>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}

function ScheduleEditor({ saved }: { saved: ScheduleValue }) {
  const qc = useQueryClient();
  const parsed = parseCron(saved.cron);

  const [mode, setMode] = useState<'simple' | 'custom'>(parsed ? 'simple' : 'custom');
  const [frequency, setFrequency] = useState<Frequency>(parsed?.frequency ?? 'daily');
  const [days, setDays] = useState<number[]>(parsed?.frequency === 'weekly' ? parsed.days : []);
  const [time, setTime] = useState(toTimeInput(parsed?.hour ?? 7, parsed?.minute ?? 0));
  const [cronDraft, setCronDraft] = useState(saved.cron);

  const save = useMutation({
    mutationFn: (body: ScheduleValue) => api.put<ScheduleResponse>('/api/digests/schedule', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digest-schedule'] }),
  });

  const parsedTime = parseTimeInput(time);
  const recurrence: Recurrence | null = parsedTime
    ? { frequency, hour: parsedTime.hour, minute: parsedTime.minute, days }
    : null;
  const simpleValid = recurrence !== null && isValidRecurrence(recurrence);
  const simpleCron = recurrence && simpleValid ? toCron(recurrence) : null;

  const dirty =
    mode === 'simple'
      ? simpleCron !== null && simpleCron !== saved.cron
      : cronDraft.trim() !== saved.cron && cronDraft.trim() !== '';
  const canSave = mode === 'simple' ? simpleCron !== null : cronDraft.trim() !== '';

  // Preview reflects whatever the editor currently describes (simple or custom).
  const preview: Recurrence | null =
    mode === 'simple' ? (simpleValid ? recurrence : null) : parseCron(cronDraft);
  const nextAt = preview && saved.enabled ? nextRun(preview, new Date()) : null;

  function chooseFrequency(next: Frequency) {
    // Seed weekly day-picks sensibly when arriving from another frequency.
    if (next === 'weekly' && days.length === 0) {
      setDays(frequency === 'weekdays' ? [1, 2, 3, 4, 5] : []);
    }
    setFrequency(next);
  }

  function toggleDay(value: string) {
    const d = Number(value);
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b),
    );
  }

  function onSave() {
    if (mode === 'custom') {
      save.mutate({ cron: cronDraft.trim(), enabled: saved.enabled });
    } else if (simpleCron) {
      save.mutate({ cron: simpleCron, enabled: saved.enabled });
    }
  }

  function enterCustom() {
    setCronDraft(simpleCron ?? saved.cron);
    setMode('custom');
  }

  function enterSimple() {
    const p = parseCron(cronDraft) ?? parseCron(saved.cron);
    if (p) {
      setFrequency(p.frequency);
      setDays(p.frequency === 'weekly' ? p.days : []);
      setTime(toTimeInput(p.hour, p.minute));
    } else {
      setFrequency('daily');
      setDays([]);
      setTime('07:00');
    }
    setMode('simple');
  }

  return (
    <SettingsSection
      title="Digest schedule"
      description="Donna writes your daily debrief automatically on this schedule."
    >
      <div className="space-y-5 max-w-xl">
        <Switch
          checked={saved.enabled}
          disabled={save.isPending}
          onChange={(v) => save.mutate({ cron: saved.cron, enabled: v })}
          label={saved.enabled ? 'Scheduled debriefs are on' : 'Scheduled debriefs are off'}
        />

        {mode === 'simple' ? (
          <div className="space-y-4">
            <FieldGroup label="Repeat">
              <Segmented value={frequency} onChange={chooseFrequency} options={FREQUENCY_OPTIONS} />
            </FieldGroup>

            {frequency === 'weekly' && (
              <FieldGroup
                label="On these days"
                hint={days.length === 0 ? 'Pick at least one day.' : undefined}
              >
                <ToggleChips
                  options={DAY_OPTIONS}
                  selected={days.map(String)}
                  onToggle={toggleDay}
                />
              </FieldGroup>
            )}

            <Field label="Time">
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-donna-300 focus:border-donna-400"
              />
            </Field>
          </div>
        ) : (
          <div className="space-y-2">
            {!parsed && (
              <p className="text-xs text-ink-muted">
                This schedule uses a cron expression the simple editor can't represent.
              </p>
            )}
            <Field label="Cron expression" hint="Five fields: minute hour day month weekday.">
              <Input
                value={cronDraft}
                onChange={(e) => setCronDraft(e.target.value)}
                placeholder="0 7 * * *"
                className="max-w-[220px] font-mono"
              />
            </Field>
          </div>
        )}

        <div className="rounded-lg border border-surface-border bg-surface-sunken/50 px-3.5 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <CalendarClock className="h-4 w-4 shrink-0 text-donna-600" />
            {preview
              ? describeRecurrence(preview)
              : mode === 'custom'
                ? 'Custom cron schedule'
                : 'Pick a time and at least one day'}
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {!saved.enabled
              ? 'Scheduled debriefs are paused — turn them on above to resume.'
              : nextAt
                ? `Next debrief ${formatNextRun(nextAt)}.`
                : 'Choose a valid schedule to see when the next debrief runs.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!dirty || !canSave}
            loading={save.isPending}
            onClick={onSave}
          >
            Save schedule
          </Button>
          <button
            type="button"
            onClick={mode === 'simple' ? enterCustom : enterSimple}
            className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            {mode === 'simple' ? 'Use a custom cron expression' : 'Switch to the simple editor'}
          </button>
          {save.isError && (
            <span className="text-sm text-red-600">{(save.error as Error).message}</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

/** A non-label field wrapper for groups of interactive controls (buttons/chips). */
function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <span className="block text-[13px] font-medium mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-muted mt-1.5">{hint}</span>}
    </div>
  );
}

/** A single-select pill group (Daily / Weekdays / Weekly). */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-surface-border bg-surface-sunken p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
              active ? 'bg-surface-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
