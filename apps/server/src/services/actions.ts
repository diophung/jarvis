/**
 * Agent actions service: the permission/approval core. Every proposed action
 * is gated by evaluatePolicy() over the workspace's enabled permission
 * policies; denied actions never execute, auto-approved actions execute
 * inline, and everything else queues an ApprovalRequest. All transitions are
 * audited.
 */
import {
  evaluatePolicy,
  fromJson,
  getCapabilityDef,
  MEMORY_KINDS,
  newId,
  nowIso,
  toJson,
  type AgentAction,
  type ApprovalRequest,
  type MemoryKind,
  type PolicyRule,
  type RiskLevel,
} from '@jarvis/core';
import type { ConnectorContext, ConnectorLogger, ConnectorRegistry } from '@jarvis/connectors';
import type { AgentActionsTable, ApprovalRequestsTable, Db } from '@jarvis/db';
import type {
  ActionsService,
  AuditService,
  MemoryService,
  ProposeActionInput,
  SecretsService,
  TokensService,
} from '../context.js';
import { conflict, notFound } from '../lib/http-errors.js';

const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const quietLogger: ConnectorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function parseAgentActionRow(row: AgentActionsTable): AgentAction {
  return {
    ...row,
    status: row.status as AgentAction['status'],
    riskLevel: row.riskLevel as RiskLevel,
    params: fromJson<Record<string, unknown>>(row.params, {}),
    target: fromJson<AgentAction['target']>(row.target, {}),
    result: row.result === null ? null : fromJson<Record<string, unknown> | null>(row.result, null),
  };
}

export function parseApprovalRow(row: ApprovalRequestsTable): ApprovalRequest {
  return {
    ...row,
    status: row.status as ApprovalRequest['status'],
    riskLevel: row.riskLevel as RiskLevel,
    targetRef: fromJson<Record<string, unknown>>(row.targetRef, {}),
    preview: fromJson<ApprovalRequest['preview']>(row.preview, { summary: '' }),
  };
}

/** Map a capability to the connector-level action type. */
function connectorActionType(capability: string, actionType: string): string {
  switch (capability) {
    case 'email.send':
      return 'send_email';
    case 'email.reply':
      return 'reply_email';
    case 'calendar.create_invite':
      return 'create_event';
    case 'calendar.update':
      return 'update_event';
    case 'chat.post':
      return 'post_message';
    default:
      return actionType;
  }
}

export function createActionsService(deps: {
  db: Db;
  connectors: ConnectorRegistry;
  secrets: SecretsService;
  audit: AuditService;
  memory: MemoryService;
  /**
   * Per-source OAuth token service. Optional only so pre-v1.1 fixtures keep
   * working — production wiring MUST pass it or write actions on
   * OAuth-connected accounts cannot authenticate.
   */
  tokens?: TokensService;
}): ActionsService {
  const { db, connectors, secrets, audit, memory, tokens } = deps;

  async function getActionRow(actionId: string): Promise<AgentActionsTable> {
    const row = await db
      .selectFrom('agentActions')
      .selectAll()
      .where('id', '=', actionId)
      .executeTakeFirst();
    if (!row) throw notFound('Agent action not found');
    return row;
  }

  async function loadRules(workspaceId: string): Promise<PolicyRule[]> {
    const rows = await db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('enabled', '=', 1)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      capability: r.capability,
      effect: r.effect as PolicyRule['effect'],
      scope: fromJson<Record<string, unknown>>(r.scope, {}),
      enabled: r.enabled,
    }));
  }

  /** Run a connector write action; throws on failure. */
  async function executeViaConnector(
    row: AgentActionsTable,
    target: AgentAction['target'],
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const provider = target.provider;
    if (!provider) throw new Error('No provider on action target');
    let accountQuery = db
      .selectFrom('sourceAccounts')
      .selectAll()
      .where('workspaceId', '=', row.workspaceId);
    accountQuery = target.accountId
      ? accountQuery.where('id', '=', target.accountId)
      : accountQuery.where('provider', '=', provider);
    const account = await accountQuery.executeTakeFirst();
    if (!account) throw new Error(`No connected source account for provider '${provider}'`);

    const connector = connectors.get(provider);
    if (!connector) throw new Error(`No connector registered for provider '${provider}'`);
    if (!connector.execute) {
      throw new Error(`Connector '${provider}' does not support write actions`);
    }
    const ctx: ConnectorContext = {
      accountId: account.id,
      workspaceId: row.workspaceId,
      settings: fromJson<Record<string, unknown>>(account.settings, {}),
      secrets: secrets.connectorResolver(),
      logger: quietLogger,
      // OAuth-connected accounts get a server-managed token source; env-based
      // accounts keep resolving credentials through ctx.secrets.
      oauth:
        tokens && tokens.isOauthAccount(account.authRef)
          ? tokens.tokenSourceFor(account.id)
          : undefined,
    };
    const result = await connector.execute(ctx, {
      type: connectorActionType(row.capability, row.actionType),
      params,
    });
    if (!result.ok) {
      throw new Error(result.detail ?? `Connector action '${row.actionType}' failed`);
    }
    const out: Record<string, unknown> = { ok: true };
    if (result.externalRef !== undefined) out.externalRef = result.externalRef;
    if (result.detail !== undefined) out.detail = result.detail;
    return out;
  }

  /** Apply a local (in-Jarvis) effect; throws on failure. */
  async function executeLocally(
    row: AgentActionsTable,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const now = nowIso();
    switch (row.capability) {
      case 'task.create': {
        const id = newId('tsk');
        await db
          .insertInto('taskCandidates')
          .values({
            id,
            workspaceId: row.workspaceId,
            sourceItemId: null,
            title: typeof params.title === 'string' && params.title ? params.title : 'Untitled task',
            description: typeof params.description === 'string' ? params.description : null,
            status: 'open',
            dueAt: typeof params.dueAt === 'string' ? params.dueAt : null,
            deferredUntil: null,
            importanceScore: 50,
            urgencyScore: 40,
            effortScore: 30,
            overallScore: 45,
            priorityLevel: 'medium',
            urgencyLevel: 'medium',
            effortLevel: 'low',
            planningCategory: 'follow_up',
            signals: toJson([]),
            explanation: 'Created by Jarvis via an approved agent action.',
            recommendedAction: null,
            projectId: null,
            peopleIds: toJson([]),
            origin: 'agent',
            createdAt: now,
            updatedAt: now,
          })
          .execute();
        return { taskCandidateId: id };
      }
      case 'draft.create': {
        // The draft lives on the action row; nothing external happens.
        return { draft: params.body, subject: params.subject };
      }
      case 'note.create': {
        const entry = await memory.create(row.workspaceId, row.userId, {
          kind: 'fact',
          content: typeof params.content === 'string' ? params.content : String(params.body ?? ''),
          origin: 'explicit',
        });
        return { memoryId: entry.id };
      }
      case 'memory.write': {
        const kind: MemoryKind = MEMORY_KINDS.includes(params.kind as MemoryKind)
          ? (params.kind as MemoryKind)
          : 'fact';
        const entry = await memory.create(row.workspaceId, row.userId, {
          kind,
          content: typeof params.content === 'string' ? params.content : '',
          origin: 'inferred',
        });
        return { memoryId: entry.id };
      }
      default:
        // Safe/read capabilities (source.read, search.query, ...) have no
        // side effect to apply here — executing them is a no-op success.
        if (getCapabilityDef(row.capability)?.risk === 'safe') {
          return { ok: true };
        }
        throw new Error(`No local executor for capability '${row.capability}'`);
    }
  }

  const service: ActionsService = {
    riskFor(capability) {
      return getCapabilityDef(capability)?.risk ?? 'high';
    },

    async propose(input: ProposeActionInput) {
      const rules = await loadRules(input.workspaceId);
      const decision = evaluatePolicy(
        {
          capability: input.capability,
          provider: input.target.provider,
          accountId: input.target.accountId,
        },
        rules,
      );
      const now = nowIso();
      const actionId = newId('act');
      const status =
        decision.effect === 'deny'
          ? 'denied'
          : decision.effect === 'auto_approve'
            ? 'auto_approved'
            : 'awaiting_approval';

      await db
        .insertInto('agentActions')
        .values({
          id: actionId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          conversationId: input.conversationId ?? null,
          messageId: input.messageId ?? null,
          capability: input.capability,
          actionType: input.actionType,
          params: toJson(input.params),
          target: toJson(input.target),
          status,
          riskLevel: decision.riskLevel,
          policyId: decision.matchedPolicyId,
          approvalRequestId: null,
          result: null,
          error: null,
          executedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .execute();

      await audit.log({
        workspaceId: input.workspaceId,
        userId: input.userId,
        eventType: 'agent.action.proposed',
        actor: 'agent',
        capability: input.capability,
        targetType: 'agent_action',
        targetId: actionId,
        summary: `Agent proposed '${input.capability}' — ${decision.effect}: ${input.preview.summary}`,
        metadata: {
          actionType: input.actionType,
          effect: decision.effect,
          riskLevel: decision.riskLevel,
          reason: decision.reason,
          denied: decision.effect === 'deny',
        },
      });

      if (decision.effect === 'deny') {
        return { action: parseAgentActionRow(await getActionRow(actionId)), decision, approval: null };
      }

      if (decision.effect === 'auto_approve') {
        try {
          await service.execute(actionId);
        } catch {
          // Execution failures are captured on the action row; propose never throws for them.
        }
        return { action: parseAgentActionRow(await getActionRow(actionId)), decision, approval: null };
      }

      // require_approval — queue an approval request.
      const approvalId = newId('apr');
      await db
        .insertInto('approvalRequests')
        .values({
          id: approvalId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          agentActionId: actionId,
          capability: input.capability,
          actionType: input.actionType,
          targetProvider: input.target.provider ?? null,
          targetAccountId: input.target.accountId ?? null,
          targetRef: toJson(input.target),
          riskLevel: decision.riskLevel,
          reason: input.reason,
          preview: toJson(input.preview),
          status: 'pending',
          requestedAt: now,
          decidedAt: null,
          decisionNote: null,
          conversationId: input.conversationId ?? null,
          expiresAt: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(),
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      await db
        .updateTable('agentActions')
        .set({ approvalRequestId: approvalId, updatedAt: nowIso() })
        .where('id', '=', actionId)
        .execute();

      await audit.log({
        workspaceId: input.workspaceId,
        userId: input.userId,
        eventType: 'approval.created',
        actor: 'agent',
        capability: input.capability,
        targetType: 'approval_request',
        targetId: approvalId,
        summary: `Approval requested for '${input.capability}': ${input.preview.summary}`,
        metadata: { actionType: input.actionType, riskLevel: decision.riskLevel, reason: input.reason },
      });

      const approvalRow = await db
        .selectFrom('approvalRequests')
        .selectAll()
        .where('id', '=', approvalId)
        .executeTakeFirstOrThrow();
      return {
        action: parseAgentActionRow(await getActionRow(actionId)),
        decision,
        approval: parseApprovalRow(approvalRow),
      };
    },

    async execute(actionId) {
      const row = await getActionRow(actionId);
      // Atomically claim the action: only the request that moves it to
      // 'executing' may run it, so execute() can never run twice.
      const claim = await db
        .updateTable('agentActions')
        .set({ status: 'executing', updatedAt: nowIso() })
        .where('id', '=', actionId)
        .where('status', 'in', ['auto_approved', 'approved'])
        .execute();
      if (Number(claim[0]?.numUpdatedRows ?? 0n) === 0) {
        throw conflict(`Action cannot be executed from status '${row.status}'`);
      }

      const params = fromJson<Record<string, unknown>>(row.params, {});
      const target = fromJson<AgentAction['target']>(row.target, {});
      try {
        const result = target.provider
          ? await executeViaConnector(row, target, params)
          : await executeLocally(row, params);
        const now = nowIso();
        await db
          .updateTable('agentActions')
          .set({ status: 'executed', result: toJson(result), error: null, executedAt: now, updatedAt: now })
          .where('id', '=', actionId)
          .execute();
        await audit.log({
          workspaceId: row.workspaceId,
          userId: row.userId,
          eventType: 'agent.action.executed',
          actor: 'agent',
          capability: row.capability,
          targetType: 'agent_action',
          targetId: actionId,
          summary: `Executed '${row.capability}' (${row.actionType})`,
          metadata: { actionType: row.actionType, result },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
          .updateTable('agentActions')
          .set({ status: 'failed', error: message, updatedAt: nowIso() })
          .where('id', '=', actionId)
          .execute();
        await audit.log({
          workspaceId: row.workspaceId,
          userId: row.userId,
          eventType: 'agent.action.failed',
          actor: 'agent',
          capability: row.capability,
          targetType: 'agent_action',
          targetId: actionId,
          summary: `Failed to execute '${row.capability}': ${message}`,
          metadata: { actionType: row.actionType, error: message },
        });
      }
      return parseAgentActionRow(await getActionRow(actionId));
    },

    async decideApproval(workspaceId, approvalId, userId, decision, opts = {}) {
      const row = await db
        .selectFrom('approvalRequests')
        .selectAll()
        .where('id', '=', approvalId)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      if (!row) throw notFound('Approval request not found');
      if (row.status !== 'pending') {
        throw conflict(`Approval already ${row.status}`);
      }
      const now = nowIso();
      if (row.expiresAt && row.expiresAt < now) {
        await db
          .updateTable('approvalRequests')
          .set({ status: 'expired', updatedAt: now })
          .where('id', '=', approvalId)
          .execute();
        await audit.log({
          workspaceId,
          userId,
          eventType: 'approval.expired',
          actor: 'system',
          capability: row.capability,
          targetType: 'approval_request',
          targetId: approvalId,
          summary: `Approval for '${row.capability}' expired before a decision`,
          metadata: { expiresAt: row.expiresAt },
        });
        throw conflict('Approval request has expired');
      }

      // Atomically claim the pending→decided transition: only one request can
      // win, so a decision (and its execution) can never be applied twice.
      const claim = await db
        .updateTable('approvalRequests')
        .set({
          status: decision === 'deny' ? 'denied' : 'approved',
          decidedAt: now,
          decisionNote: opts.note ?? null,
          updatedAt: now,
        })
        .where('id', '=', approvalId)
        .where('status', '=', 'pending')
        .execute();
      if (Number(claim[0]?.numUpdatedRows ?? 0n) === 0) {
        throw conflict('Approval already decided');
      }

      if (decision === 'deny') {
        await db
          .updateTable('agentActions')
          .set({ status: 'denied', updatedAt: now })
          .where('id', '=', row.agentActionId)
          .where('status', '=', 'awaiting_approval')
          .execute();
        await audit.log({
          workspaceId,
          userId,
          eventType: 'approval.denied',
          actor: 'user',
          capability: row.capability,
          targetType: 'approval_request',
          targetId: approvalId,
          summary: `Denied '${row.capability}' (${row.actionType})`,
          metadata: { note: opts.note ?? null },
        });
      } else {
        await db
          .updateTable('agentActions')
          .set({ status: 'approved', updatedAt: now })
          .where('id', '=', row.agentActionId)
          .where('status', '=', 'awaiting_approval')
          .execute();
        // Critical-risk capabilities (e.g. source.delete) are never
        // auto-approved: approve this single action but skip rule creation.
        const alwaysAllowSkipped =
          opts.alwaysAllow === true && getCapabilityDef(row.capability)?.risk === 'critical';
        await audit.log({
          workspaceId,
          userId,
          eventType: 'approval.approved',
          actor: 'user',
          capability: row.capability,
          targetType: 'approval_request',
          targetId: approvalId,
          summary: `Approved '${row.capability}' (${row.actionType})`,
          metadata: {
            note: opts.note ?? null,
            alwaysAllow: opts.alwaysAllow === true,
            ...(alwaysAllowSkipped
              ? {
                  alwaysAllowSkipped: true,
                  alwaysAllowSkipReason: 'critical-risk capabilities are never auto-approved',
                }
              : {}),
          },
        });

        if (opts.alwaysAllow && !alwaysAllowSkipped) {
          // Scope the rule to the approved target (workspace-wide only for
          // local capabilities with no provider/account).
          const scope: Record<string, string> = {};
          if (row.targetProvider !== null) scope.provider = row.targetProvider;
          if (row.targetAccountId !== null) scope.accountId = row.targetAccountId;
          const scopeJson = toJson(scope);
          const existingRule = await db
            .selectFrom('permissionPolicies')
            .select(['id'])
            .where('workspaceId', '=', workspaceId)
            .where('capability', '=', row.capability)
            .where('effect', '=', 'auto_approve')
            .where('enabled', '=', 1)
            .where('scope', '=', scopeJson)
            .executeTakeFirst();
          if (!existingRule) {
            const scopeSummary = row.targetProvider
              ? `${row.targetProvider}${row.targetAccountId ? ` (account ${row.targetAccountId})` : ''}`
              : null;
            const policyId = newId('pol');
            await db
              .insertInto('permissionPolicies')
              .values({
                id: policyId,
                workspaceId,
                userId,
                capability: row.capability,
                effect: 'auto_approve',
                scope: scopeJson,
                description: scopeSummary
                  ? `Always allow on ${scopeSummary} — created from approval`
                  : 'Always allow — created from approval',
                createdBy: 'approval_flow',
                enabled: 1,
                createdAt: now,
                updatedAt: now,
              })
              .execute();
            await audit.log({
              workspaceId,
              userId,
              eventType: 'policy.updated',
              actor: 'user',
              capability: row.capability,
              targetType: 'permission_policy',
              targetId: policyId,
              summary: `Always allow '${row.capability}' (created from approval)`,
              metadata: { effect: 'auto_approve', createdBy: 'approval_flow', scope },
            });
          }
        }

        await service.execute(row.agentActionId);
      }

      const refreshed = await db
        .selectFrom('approvalRequests')
        .selectAll()
        .where('id', '=', approvalId)
        .executeTakeFirstOrThrow();
      return parseApprovalRow(refreshed);
    },

    async listApprovals(workspaceId, status) {
      let q = db
        .selectFrom('approvalRequests')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .orderBy('requestedAt', 'desc');
      if (status) q = q.where('status', '=', status);
      const rows = await q.execute();
      return rows.map(parseApprovalRow);
    },
  };

  return service;
}
