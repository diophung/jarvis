/**
 * User preference routes (explicit preferences keyed by well-known keys).
 */
import { fromJson, newId, nowIso, toJson, type UserPreference } from '@donna/core';
import type { UserPreferencesTable } from '@donna/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';

export function parsePreferenceRow(row: UserPreferencesTable): UserPreference {
  return {
    ...row,
    value: fromJson<unknown>(row.value, null),
    kind: row.kind as UserPreference['kind'],
    origin: row.origin as UserPreference['origin'],
  };
}

export function registerPreferenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/preferences', async (request) => {
    const rows = await ctx.db
      .selectFrom('userPreferences')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .where('userId', '=', request.userId)
      .orderBy('key', 'asc')
      .execute();
    return { items: rows.map(parsePreferenceRow) };
  });

  app.put('/api/preferences/:key', async (request) => {
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(request.params);
    const body = request.body;
    if (typeof body !== 'object' || body === null || !('value' in body)) {
      throw badRequest("Request body must include 'value'");
    }
    const value = (body as Record<string, unknown>).value;
    const now = nowIso();

    const existing = await ctx.db
      .selectFrom('userPreferences')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .where('userId', '=', request.userId)
      .where('key', '=', key)
      .executeTakeFirst();

    let prefId: string;
    if (existing) {
      prefId = existing.id;
      await ctx.db
        .updateTable('userPreferences')
        .set({ value: toJson(value), kind: 'explicit', origin: 'user', updatedAt: now })
        .where('id', '=', existing.id)
        .execute();
    } else {
      prefId = newId('prf');
      await ctx.db
        .insertInto('userPreferences')
        .values({
          id: prefId,
          workspaceId: request.workspaceId,
          userId: request.userId,
          key,
          value: toJson(value),
          kind: 'explicit',
          origin: 'user',
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    }

    await ctx.services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'preference.updated',
      actor: 'user',
      targetType: 'user_preference',
      targetId: prefId,
      summary: `Preference '${key}' updated`,
      metadata: { key, value },
    });

    const row = await ctx.db
      .selectFrom('userPreferences')
      .selectAll()
      .where('id', '=', prefId)
      .executeTakeFirstOrThrow();
    return { preference: parsePreferenceRow(row) };
  });

  app.delete('/api/preferences/:key', async (request) => {
    const { key } = z.object({ key: z.string().min(1) }).parse(request.params);
    const existing = await ctx.db
      .selectFrom('userPreferences')
      .select(['id'])
      .where('workspaceId', '=', request.workspaceId)
      .where('userId', '=', request.userId)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!existing) throw notFound('Preference not found');
    await ctx.db.deleteFrom('userPreferences').where('id', '=', existing.id).execute();
    await ctx.services.audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'preference.updated',
      actor: 'user',
      targetType: 'user_preference',
      targetId: existing.id,
      summary: `Preference '${key}' removed`,
      metadata: { key, removed: true },
    });
    return { ok: true };
  });
}
