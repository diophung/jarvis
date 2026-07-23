/**
 * Approval queue + agent action history routes.
 */
import { AGENT_ACTION_STATUSES, APPROVAL_STATUSES } from '@jarvis/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest } from '../lib/http-errors.js';
import { parseAgentActionRow } from '../services/actions.js';

const ListApprovalsQuery = z.object({ status: z.enum(APPROVAL_STATUSES).optional() });

const DecideBody = z.object({
  decision: z.enum(['approve', 'deny']),
  note: z.string().max(2000).optional(),
  alwaysAllow: z.boolean().optional(),
});

const ListActionsQuery = z.object({
  status: z.enum(AGENT_ACTION_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/approvals', async (request) => {
    const query = ListApprovalsQuery.safeParse(request.query);
    if (!query.success) throw badRequest('Invalid status filter');
    const items = await ctx.services.actions.listApprovals(request.workspaceId, query.data.status);
    return { items };
  });

  app.post('/api/approvals/:id/decide', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = DecideBody.safeParse(request.body);
    if (!body.success) throw badRequest("decision must be 'approve' or 'deny'");
    const approval = await ctx.services.actions.decideApproval(
      request.workspaceId,
      id,
      request.userId,
      body.data.decision,
      { note: body.data.note, alwaysAllow: body.data.alwaysAllow },
    );
    const actionRow = await ctx.db
      .selectFrom('agentActions')
      .selectAll()
      .where('id', '=', approval.agentActionId)
      .where('workspaceId', '=', request.workspaceId)
      .executeTakeFirst();
    return { approval, action: actionRow ? parseAgentActionRow(actionRow) : null };
  });

  app.get('/api/actions', async (request) => {
    const query = ListActionsQuery.safeParse(request.query);
    if (!query.success) throw badRequest('Invalid actions query');
    let q = ctx.db
      .selectFrom('agentActions')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(query.data.limit ?? 50);
    if (query.data.status) q = q.where('status', '=', query.data.status);
    const rows = await q.execute();
    return { items: rows.map(parseAgentActionRow) };
  });
}
