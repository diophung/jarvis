/**
 * Permission policy routes: the capability catalog plus the user's rules.
 */
import {
  CAPABILITY_CATALOG,
  fromJson,
  getCapabilityDef,
  newId,
  nowIso,
  POLICY_EFFECTS,
  toJson,
  type PermissionPolicy,
  type PolicyEffect,
} from '@jarvis/core';
import type { PermissionPoliciesTable } from '@jarvis/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

export function parsePolicyRow(row: PermissionPoliciesTable): PermissionPolicy {
  return {
    ...row,
    effect: row.effect as PolicyEffect,
    createdBy: row.createdBy as PermissionPolicy['createdBy'],
    scope: fromJson<Record<string, unknown>>(row.scope, {}),
  };
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const PutPolicyBody = z.object({ effect: z.enum(POLICY_EFFECTS) });

export function registerPolicyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/policies/catalog', async () => ({ items: CAPABILITY_CATALOG }));

  app.get('/api/policies', async (request) => {
    const rows = await ctx.db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('createdAt', 'desc')
      .execute();
    return { items: rows.map(parsePolicyRow) };
  });

  app.put('/api/policies/:capability', async (request) => {
    const params = z.object({ capability: z.string().min(1) }).parse(request.params);
    const capability = safeDecode(params.capability);
    const body = PutPolicyBody.safeParse(request.body);
    if (!body.success) {
      throw badRequest("effect must be one of 'auto_approve', 'require_approval', 'deny'");
    }
    const effect = body.data.effect;
    if (effect === 'auto_approve' && getCapabilityDef(capability)?.risk === 'critical') {
      throw badRequest(
        `'${capability}' can cause irreversible damage, so Jarvis will always ask before doing it. It cannot be set to run automatically.`,
        'critical_capability',
      );
    }

    const existing = await ctx.db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .where('capability', '=', capability)
      .where('userId', '=', request.userId)
      .executeTakeFirst();
    if (!getCapabilityDef(capability) && !existing) {
      throw badRequest(`Unknown capability '${capability}'`, 'unknown_capability');
    }

    const now = nowIso();
    let policyId: string;
    if (existing) {
      policyId = existing.id;
      await ctx.db
        .updateTable('permissionPolicies')
        .set({ effect, createdBy: 'user', enabled: 1, updatedAt: now })
        .where('id', '=', existing.id)
        .execute();
    } else {
      policyId = newId('pol');
      await ctx.db
        .insertInto('permissionPolicies')
        .values({
          id: policyId,
          workspaceId: request.workspaceId,
          userId: request.userId,
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
    }

    await ctx.services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'policy.updated',
      actor: 'user',
      capability,
      targetType: 'permission_policy',
      targetId: policyId,
      summary: `Policy for '${capability}' set to ${effect}`,
      metadata: {
        capability,
        oldEffect: existing?.effect ?? getCapabilityDef(capability)?.defaultEffect ?? 'default',
        newEffect: effect,
      },
    });

    const row = await ctx.db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('id', '=', policyId)
      .executeTakeFirstOrThrow();
    return { policy: parsePolicyRow(row) };
  });

  app.delete('/api/policies/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const existing = await ctx.db
      .selectFrom('permissionPolicies')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', request.workspaceId)
      .executeTakeFirst();
    if (!existing) throw notFound('Policy not found');
    await ctx.db.deleteFrom('permissionPolicies').where('id', '=', id).execute();
    await ctx.services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'policy.updated',
      actor: 'user',
      capability: existing.capability,
      targetType: 'permission_policy',
      targetId: id,
      summary: `Policy for '${existing.capability}' removed (reverted to default)`,
      metadata: {
        capability: existing.capability,
        oldEffect: existing.effect,
        newEffect: getCapabilityDef(existing.capability)?.defaultEffect ?? 'default',
        reverted: true,
      },
    });
    return { ok: true };
  });
}
