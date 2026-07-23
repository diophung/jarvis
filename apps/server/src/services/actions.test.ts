import { fromJson, newId, nowIso, toJson } from '@jarvis/core';
import { createDefaultRegistry } from '@jarvis/connectors';
import type { Db } from '@jarvis/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionsService, MemoryService, ProposeActionInput } from '../context.js';
import { HttpError } from '../lib/http-errors.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createActionsService } from './actions.js';
import { createAuditService } from './audit.js';
import { createMemoryService } from './memory.js';
import { createSecretsService } from './secrets.js';
import { createSettingsService } from './settings.js';

let db: Db;
let workspaceId: string;
let userId: string;
let actions: ActionsService;
let memory: MemoryService;

async function seedMockEmailAccount(): Promise<string> {
  const now = nowIso();
  const id = newId('acc');
  await db
    .insertInto('sourceAccounts')
    .values({
      id,
      workspaceId,
      userId,
      provider: 'mock-email',
      category: 'email',
      displayName: 'Demo Email',
      status: 'connected',
      authRef: null,
      scopes: toJson([]),
      capabilities: toJson(['read', 'list', 'search', 'send']),
      settings: toJson({}),
      lastSyncAt: null,
      syncCursor: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

function proposal(overrides: Partial<ProposeActionInput> = {}): ProposeActionInput {
  return {
    workspaceId,
    userId,
    capability: 'source.read',
    actionType: 'read',
    params: {},
    target: {},
    reason: 'Test reason',
    preview: { summary: 'Test preview' },
    ...overrides,
  };
}

async function insertPolicy(capability: string, effect: string): Promise<string> {
  const now = nowIso();
  const id = newId('pol');
  await db
    .insertInto('permissionPolicies')
    .values({
      id,
      workspaceId,
      userId,
      capability,
      effect,
      scope: toJson({}),
      description: null,
      createdBy: 'user',
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}

async function auditEvents(eventType: string) {
  return db
    .selectFrom('auditLogs')
    .selectAll()
    .where('workspaceId', '=', workspaceId)
    .where('eventType', '=', eventType)
    .execute();
}

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  memory = createMemoryService({ db, settings, audit });
  actions = createActionsService({
    db,
    connectors: createDefaultRegistry(),
    secrets: createSecretsService({ appSecret: 'test-secret' }),
    audit,
    memory,
  });
});

describe('propose matrix', () => {
  it('auto-approves and executes source.read', async () => {
    const { action, decision, approval } = await actions.propose(proposal());
    expect(decision.effect).toBe('auto_approve');
    expect(approval).toBeNull();
    expect(action.status).toBe('executed');
    expect((await auditEvents('agent.action.proposed')).length).toBe(1);
    expect((await auditEvents('agent.action.executed')).length).toBe(1);
  });

  it('queues an approval for email.send when no rules exist', async () => {
    const { action, decision, approval } = await actions.propose(
      proposal({
        capability: 'email.send',
        actionType: 'send_email',
        params: { to: 'jin@example.com', subject: 'Hello' },
        target: { provider: 'mock-email' },
      }),
    );
    expect(decision.effect).toBe('require_approval');
    expect(action.status).toBe('awaiting_approval');
    expect(approval).not.toBeNull();
    expect(approval?.status).toBe('pending');
    expect(approval?.riskLevel).toBe('high');
    expect(approval?.agentActionId).toBe(action.id);
    expect(action.approvalRequestId).toBe(approval?.id);
    // expiresAt ≈ +7 days
    const deltaMs = Date.parse(approval?.expiresAt ?? '') - Date.parse(approval?.requestedAt ?? '');
    expect(deltaMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect((await auditEvents('approval.created')).length).toBe(1);
  });

  it('denies without creating an approval when a deny rule matches', async () => {
    await insertPolicy('email.send', 'deny');
    const { action, decision, approval } = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email' }),
    );
    expect(decision.effect).toBe('deny');
    expect(action.status).toBe('denied');
    expect(approval).toBeNull();
    const approvals = await db.selectFrom('approvalRequests').selectAll().execute();
    expect(approvals).toHaveLength(0);
    const proposed = await auditEvents('agent.action.proposed');
    expect(proposed[0]?.metadata).toContain('"denied":true');
  });

  it('auto-approves task.create and inserts a task candidate', async () => {
    const { action } = await actions.propose(
      proposal({
        capability: 'task.create',
        actionType: 'create_task',
        params: { title: 'Follow up with Jin', description: 'Re: budget', dueAt: '2026-06-12T09:00:00.000Z' },
      }),
    );
    expect(action.status).toBe('executed');
    const taskId = action.result?.taskCandidateId;
    expect(typeof taskId).toBe('string');
    const task = await db
      .selectFrom('taskCandidates')
      .selectAll()
      .where('id', '=', String(taskId))
      .executeTakeFirst();
    expect(task?.title).toBe('Follow up with Jin');
    expect(task?.origin).toBe('agent');
    expect(task?.planningCategory).toBe('follow_up');
    expect(task?.status).toBe('open');
  });

  it('requires approval for an unknown capability at high risk', async () => {
    const { action, decision, approval } = await actions.propose(
      proposal({ capability: 'crypto.transfer', actionType: 'transfer' }),
    );
    expect(decision.effect).toBe('require_approval');
    expect(decision.unknownCapability).toBe(true);
    expect(decision.riskLevel).toBe('high');
    expect(action.status).toBe('awaiting_approval');
    expect(approval?.status).toBe('pending');
  });

  it('never throws out of propose when auto-approved execution fails', async () => {
    await insertPolicy('email.send', 'auto_approve');
    // No mock-email account connected -> connector execution fails.
    const { action, decision } = await actions.propose(
      proposal({
        capability: 'email.send',
        actionType: 'send_email',
        params: { to: 'a@b.com', subject: 'x' },
        target: { provider: 'mock-email' },
      }),
    );
    expect(decision.effect).toBe('auto_approve');
    expect(action.status).toBe('failed');
    expect(action.error).toBeTruthy();
    expect((await auditEvents('agent.action.failed')).length).toBe(1);
  });
});

describe('execute', () => {
  it('refuses to execute an action awaiting approval', async () => {
    const { action } = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email' }),
    );
    await expect(actions.execute(action.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('creates a draft locally for draft.create', async () => {
    const { action } = await actions.propose(
      proposal({
        capability: 'draft.create',
        actionType: 'create_draft',
        params: { body: 'Draft body', subject: 'Draft subject' },
      }),
    );
    expect(action.status).toBe('executed');
    expect(action.result).toEqual({ draft: 'Draft body', subject: 'Draft subject' });
  });

  it('writes a memory entry for memory.write with kind from params', async () => {
    const { action } = await actions.propose(
      proposal({
        capability: 'memory.write',
        actionType: 'write_memory',
        params: { kind: 'preference', content: 'Prefers concise replies' },
      }),
    );
    expect(action.status).toBe('executed');
    const entries = await memory.list(workspaceId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('preference');
    expect(entries[0]?.origin).toBe('inferred');
  });
});

describe('decideApproval', () => {
  it('approve on a mock-email send executes via the connector with an externalRef', async () => {
    const accountId = await seedMockEmailAccount();
    const { approval } = await actions.propose(
      proposal({
        capability: 'email.send',
        actionType: 'send_email',
        params: { to: 'jin@example.com', subject: 'Budget', body: 'Numbers attached.' },
        target: { provider: 'mock-email', accountId },
      }),
    );
    const decided = await actions.decideApproval(workspaceId, approval!.id, userId, 'approve', {
      note: 'Looks good',
    });
    expect(decided.status).toBe('approved');
    expect(decided.decisionNote).toBe('Looks good');
    const action = await db
      .selectFrom('agentActions')
      .selectAll()
      .where('id', '=', decided.agentActionId)
      .executeTakeFirstOrThrow();
    expect(action.status).toBe('executed');
    expect(action.result).toContain('mock-email-sent-');
    expect((await auditEvents('approval.approved')).length).toBe(1);
    expect((await auditEvents('agent.action.executed')).length).toBe(1);
  });

  it('deny marks the action denied', async () => {
    const { approval } = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email' }),
    );
    const decided = await actions.decideApproval(workspaceId, approval!.id, userId, 'deny', {
      note: 'Not now',
    });
    expect(decided.status).toBe('denied');
    const action = await db
      .selectFrom('agentActions')
      .selectAll()
      .where('id', '=', decided.agentActionId)
      .executeTakeFirstOrThrow();
    expect(action.status).toBe('denied');
    expect((await auditEvents('approval.denied')).length).toBe(1);
  });

  it('alwaysAllow creates a target-scoped policy and a second propose auto-executes', async () => {
    const accountId = await seedMockEmailAccount();
    const target = { provider: 'mock-email', accountId };
    const params = { to: 'jin@example.com', subject: 'Hi', body: 'First' };
    const { approval } = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email', params, target }),
    );
    await actions.decideApproval(workspaceId, approval!.id, userId, 'approve', { alwaysAllow: true });

    const policies = await db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(policies).toHaveLength(1);
    expect(policies[0]?.capability).toBe('email.send');
    expect(policies[0]?.effect).toBe('auto_approve');
    expect(policies[0]?.createdBy).toBe('approval_flow');
    // The rule is scoped to the approved target, not workspace-wide.
    expect(fromJson(policies[0]!.scope, {})).toEqual({ provider: 'mock-email', accountId });
    expect(policies[0]?.description).toBe(
      `Always allow on mock-email (account ${accountId}) — created from approval`,
    );
    expect((await auditEvents('policy.updated')).length).toBe(1);

    const second = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email', params, target }),
    );
    expect(second.decision.effect).toBe('auto_approve');
    expect(second.approval).toBeNull();
    expect(second.action.status).toBe('executed');
    expect(second.action.result?.externalRef).toContain('mock-email-sent-');

    // A different provider target is outside the rule's scope: still gated.
    const other = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email', params, target: { provider: 'mock-chat' } }),
    );
    expect(other.decision.effect).toBe('require_approval');
    expect(other.action.status).toBe('awaiting_approval');
  });

  it('alwaysAllow skips inserting a duplicate of an equivalent enabled rule', async () => {
    const accountId = await seedMockEmailAccount();
    const target = { provider: 'mock-email', accountId };
    const params = { to: 'jin@example.com', subject: 'Hi', body: 'x' };
    const first = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email', params, target }),
    );
    const second = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email', params, target }),
    );
    await actions.decideApproval(workspaceId, first.approval!.id, userId, 'approve', { alwaysAllow: true });
    await actions.decideApproval(workspaceId, second.approval!.id, userId, 'approve', { alwaysAllow: true });

    const policies = await db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(policies).toHaveLength(1);
    expect((await auditEvents('policy.updated')).length).toBe(1);
  });

  it('alwaysAllow on a critical capability approves the action but never creates a rule', async () => {
    const { approval } = await actions.propose(
      proposal({ capability: 'source.delete', actionType: 'delete_item' }),
    );
    const decided = await actions.decideApproval(workspaceId, approval!.id, userId, 'approve', {
      alwaysAllow: true,
    });
    expect(decided.status).toBe('approved');

    const policies = await db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .execute();
    expect(policies).toHaveLength(0);
    expect((await auditEvents('policy.updated')).length).toBe(0);
    const approved = await auditEvents('approval.approved');
    expect(approved[0]?.metadata).toContain('"alwaysAllowSkipped":true');
  });

  it('decides an approval exactly once: the second decide conflicts and the connector runs once', async () => {
    const accountId = await seedMockEmailAccount();
    const registry = createDefaultRegistry();
    const mockEmail = registry.get('mock-email')!;
    const executeSpy = vi.spyOn(mockEmail, 'execute');
    const audit = createAuditService({ db });
    const settings = createSettingsService({ db });
    const spiedActions = createActionsService({
      db,
      connectors: registry,
      secrets: createSecretsService({ appSecret: 'test-secret' }),
      audit,
      memory: createMemoryService({ db, settings, audit }),
    });

    const { approval } = await spiedActions.propose(
      proposal({
        capability: 'email.send',
        actionType: 'send_email',
        params: { to: 'jin@example.com', subject: 'Once', body: 'Only once.' },
        target: { provider: 'mock-email', accountId },
      }),
    );
    const decided = await spiedActions.decideApproval(workspaceId, approval!.id, userId, 'approve');
    expect(decided.status).toBe('approved');
    await expect(
      spiedActions.decideApproval(workspaceId, approval!.id, userId, 'approve'),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // Even racing decisions only let one request claim the approval.
    const { approval: approval2 } = await spiedActions.propose(
      proposal({
        capability: 'email.send',
        actionType: 'send_email',
        params: { to: 'jin@example.com', subject: 'Race', body: 'Still once.' },
        target: { provider: 'mock-email', accountId },
      }),
    );
    const outcomes = await Promise.allSettled([
      spiedActions.decideApproval(workspaceId, approval2!.id, userId, 'approve'),
      spiedActions.decideApproval(workspaceId, approval2!.id, userId, 'approve'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it('execute can never run twice for the same action', async () => {
    const accountId = await seedMockEmailAccount();
    const { approval } = await actions.propose(
      proposal({
        capability: 'email.send',
        actionType: 'send_email',
        params: { to: 'jin@example.com', subject: 'Hi', body: 'x' },
        target: { provider: 'mock-email', accountId },
      }),
    );
    const decided = await actions.decideApproval(workspaceId, approval!.id, userId, 'approve');
    await expect(actions.execute(decided.agentActionId)).rejects.toMatchObject({ statusCode: 409 });
    expect((await auditEvents('agent.action.executed')).length).toBe(1);
  });

  it('refuses to decide an expired approval', async () => {
    const { approval } = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email' }),
    );
    await db
      .updateTable('approvalRequests')
      .set({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .where('id', '=', approval!.id)
      .execute();
    await expect(
      actions.decideApproval(workspaceId, approval!.id, userId, 'approve'),
    ).rejects.toMatchObject({ statusCode: 409 });
    const row = await db
      .selectFrom('approvalRequests')
      .selectAll()
      .where('id', '=', approval!.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
    expect((await auditEvents('approval.expired')).length).toBe(1);
  });

  it('404s on a missing approval and 409s on an already-decided one', async () => {
    await expect(
      actions.decideApproval(workspaceId, 'apr_missing', userId, 'approve'),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      actions.decideApproval(workspaceId, 'apr_missing', userId, 'approve'),
    ).rejects.toMatchObject({ statusCode: 404 });

    const { approval } = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email' }),
    );
    await actions.decideApproval(workspaceId, approval!.id, userId, 'deny');
    await expect(
      actions.decideApproval(workspaceId, approval!.id, userId, 'approve'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listApprovals + riskFor', () => {
  it('lists approvals newest first with parsed preview, filtered by status', async () => {
    const a = await actions.propose(
      proposal({ capability: 'email.send', actionType: 'send_email', preview: { summary: 'First' } }),
    );
    const b = await actions.propose(
      proposal({ capability: 'chat.post', actionType: 'post_message', preview: { summary: 'Second' } }),
    );
    await actions.decideApproval(workspaceId, a.approval!.id, userId, 'deny');

    const pending = await actions.listApprovals(workspaceId, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(b.approval?.id);
    expect(pending[0]?.preview).toEqual({ summary: 'Second' });

    const all = await actions.listApprovals(workspaceId);
    expect(all).toHaveLength(2);
  });

  it('riskFor falls back to high for unknown capabilities', () => {
    expect(actions.riskFor('email.send')).toBe('high');
    expect(actions.riskFor('source.read')).toBe('safe');
    expect(actions.riskFor('totally.unknown')).toBe('high');
  });
});
