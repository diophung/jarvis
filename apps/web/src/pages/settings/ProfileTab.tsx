import type { User } from '@donna/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Input, LoadingPane } from '../../components/ui.js';
import { api } from '../../lib/api.js';
import { useMe } from '../../lib/hooks.js';
import { Field, InfoRow, SettingsSection } from './shared.js';

export function ProfileTab() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  // null = untouched (mirror server value); string = local edit in progress.
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: { name: string; email: string }) =>
      api.patch<{ user: User }>('/api/me', body),
    onSuccess: () => {
      setName(null);
      setEmail(null);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (isLoading || !me) return <LoadingPane label="Loading profile…" />;

  const nameValue = name ?? me.user.name;
  const emailValue = email ?? me.user.email;
  const dirty = nameValue !== me.user.name || emailValue !== me.user.email;

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Profile"
        description="How Donna addresses you and where account-level notices go."
      >
        <div className="grid gap-4 sm:grid-cols-2 max-w-xl">
          <Field label="Name">
            <Input value={nameValue} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={emailValue} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!dirty || nameValue.trim() === '' || emailValue.trim() === ''}
            loading={save.isPending}
            onClick={() => save.mutate({ name: nameValue.trim(), email: emailValue.trim() })}
          >
            Save changes
          </Button>
          {save.isSuccess && !dirty && <span className="text-sm text-emerald-700">Saved.</span>}
          {save.isError && (
            <span className="text-sm text-red-600">{(save.error as Error).message}</span>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Workspace" description="Your data lives in a single workspace.">
        <InfoRow label="Workspace">{me.workspace.name}</InfoRow>
        <InfoRow label="Sign-in mode">
          {me.authMode === 'local' ? (
            <span className="inline-flex items-center gap-2">
              <Badge tone="green">local</Badge>
              <span className="text-ink-muted">
                Single-user, automatic sign-in — meant for your own machine.
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <Badge tone="blue">password</Badge>
              <span className="text-ink-muted">Email and password sign-in.</span>
            </span>
          )}
        </InfoRow>
        <InfoRow label="Role">{me.user.role}</InfoRow>
      </SettingsSection>
    </div>
  );
}
