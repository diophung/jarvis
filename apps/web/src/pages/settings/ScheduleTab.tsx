import type { Digest } from '@donna/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sun } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input, LoadingPane, Switch } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { Field, SettingsSection } from './shared.js';

interface ScheduleResponse {
  schedule: { cron: string; enabled: boolean };
}

const PRESETS = [
  { label: 'Every morning at 7:00', cron: '0 7 * * *' },
  { label: 'Every morning at 8:00', cron: '0 8 * * *' },
  { label: 'Weekdays at 7:30', cron: '30 7 * * 1-5' },
] as const;

export function ScheduleTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['digest-schedule'],
    queryFn: () => api.get<ScheduleResponse>('/api/digests/schedule'),
  });
  const [forceCustom, setForceCustom] = useState(false);
  const [cronDraft, setCronDraft] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);

  const save = useMutation({
    mutationFn: (body: { cron: string; enabled: boolean }) =>
      api.put<ScheduleResponse>('/api/digests/schedule', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digest-schedule'] }),
  });
  const generate = useMutation({
    mutationFn: () =>
      api.post<{ digest: Digest }>('/api/digests/generate', { kind: 'manual' }),
    onSuccess: () => {
      setGenerated(true);
      qc.invalidateQueries({ queryKey: ['digests'] });
    },
  });

  if (isLoading || !data) return <LoadingPane label="Loading schedule…" />;

  const { cron, enabled } = data.schedule;
  const matchedPreset = PRESETS.find((p) => p.cron === cron);
  const isCustom = forceCustom || !matchedPreset;
  const selectValue = isCustom ? 'custom' : cron;
  const cronValue = cronDraft ?? cron;

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Digest schedule"
        description="Donna writes your daily debrief automatically on this schedule."
      >
        <div className="space-y-4 max-w-xl">
          <Switch
            checked={enabled}
            onChange={(v) => save.mutate({ cron, enabled: v })}
            label={enabled ? 'Scheduled debriefs are on' : 'Scheduled debriefs are off'}
          />
          <Field label="When">
            <select
              value={selectValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'custom') {
                  setForceCustom(true);
                  return;
                }
                setForceCustom(false);
                setCronDraft(null);
                save.mutate({ cron: v, enabled });
              }}
              className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-donna-300 w-full"
            >
              {PRESETS.map((p) => (
                <option key={p.cron} value={p.cron}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </Field>
          {isCustom && (
            <Field label="Cron expression" hint="Five fields: minute hour day month weekday.">
              <div className="flex items-center gap-2">
                <Input
                  value={cronValue}
                  onChange={(e) => setCronDraft(e.target.value)}
                  placeholder="0 7 * * *"
                  className="max-w-[200px] font-mono"
                />
                <Button
                  size="sm"
                  disabled={cronDraft === null || cronDraft.trim() === cron}
                  loading={save.isPending}
                  onClick={() =>
                    save.mutate(
                      { cron: cronValue.trim(), enabled },
                      { onSuccess: () => setCronDraft(null) },
                    )
                  }
                >
                  Save
                </Button>
              </div>
            </Field>
          )}
          <p className="text-xs text-ink-muted">
            Next run follows the cron schedule <code className="bg-surface-sunken rounded px-1">{cron}</code>
            {enabled ? '' : ' (currently paused)'}.
          </p>
        </div>
      </SettingsSection>

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
