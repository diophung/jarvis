/**
 * Memory service: durable personalization entries the user can inspect,
 * edit, export, and disable entirely. Every mutation is audited; relevance
 * lookup is a cheap token-overlap ranking (no LLM required).
 */
import { fromJson, newId, nowIso, toJson, type MemoryEntry } from '@donna/core';
import type { Db, MemoryEntriesTable } from '@donna/db';
import { SETTING_KEYS, type AuditService, type MemoryService, type SettingsService } from '../context.js';
import { notFound } from '../lib/http-errors.js';

export function parseMemoryRow(row: MemoryEntriesTable): MemoryEntry {
  return {
    ...row,
    kind: row.kind as MemoryEntry['kind'],
    origin: row.origin as MemoryEntry['origin'],
    relatedPeopleIds: fromJson<string[]>(row.relatedPeopleIds, []),
    relatedProjectIds: fromJson<string[]>(row.relatedProjectIds, []),
    provenance: fromJson<MemoryEntry['provenance']>(row.provenance, {}),
  };
}

/** Lowercased alphanumeric tokens (length >= 3) for overlap scoring. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

export function createMemoryService(deps: {
  db: Db;
  settings: SettingsService;
  audit: AuditService;
}): MemoryService {
  const { db, settings, audit } = deps;

  async function getRow(workspaceId: string, id: string): Promise<MemoryEntriesTable> {
    const row = await db
      .selectFrom('memoryEntries')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!row) throw notFound('Memory entry not found');
    return row;
  }

  const service: MemoryService = {
    async isEnabled(workspaceId) {
      return settings.get<boolean>(workspaceId, SETTING_KEYS.memoryEnabled, true);
    },

    async list(workspaceId, opts = {}) {
      let q = db
        .selectFrom('memoryEntries')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .orderBy('createdAt', 'desc');
      if (!opts.includeDisabled) q = q.where('enabled', '=', 1);
      const rows = await q.execute();
      return rows.map(parseMemoryRow);
    },

    async create(workspaceId, userId, input) {
      const now = nowIso();
      const id = newId('mem');
      await db
        .insertInto('memoryEntries')
        .values({
          id,
          workspaceId,
          userId,
          kind: input.kind,
          content: input.content,
          origin: input.origin,
          confidence: input.confidence ?? (input.origin === 'explicit' ? 1 : 0.7),
          enabled: 1,
          relatedPeopleIds: toJson([]),
          relatedProjectIds: toJson([]),
          provenance: toJson(input.provenance ?? {}),
          lastUsedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .execute();
      await audit.log({
        workspaceId,
        userId,
        eventType: 'memory.created',
        actor: input.origin === 'explicit' ? 'user' : 'agent',
        targetType: 'memory_entry',
        targetId: id,
        summary: `Memory created (${input.kind}): ${input.content.slice(0, 120)}`,
        metadata: { kind: input.kind, origin: input.origin },
      });
      const row = await getRow(workspaceId, id);
      return parseMemoryRow(row);
    },

    async update(workspaceId, id, patch) {
      const existing = await getRow(workspaceId, id);
      const now = nowIso();
      const set: Partial<MemoryEntriesTable> = { updatedAt: now };
      if (patch.content !== undefined) set.content = patch.content;
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      await db.updateTable('memoryEntries').set(set).where('id', '=', existing.id).execute();

      const toggled = patch.enabled !== undefined && patch.enabled !== existing.enabled;
      await audit.log({
        workspaceId,
        userId: existing.userId,
        eventType: toggled ? 'memory.toggled' : 'memory.updated',
        actor: 'user',
        targetType: 'memory_entry',
        targetId: id,
        summary: toggled
          ? `Memory entry ${patch.enabled === 1 ? 'enabled' : 'disabled'}`
          : 'Memory entry updated',
        metadata: { fields: Object.keys(patch) },
      });
      const row = await getRow(workspaceId, id);
      return parseMemoryRow(row);
    },

    async remove(workspaceId, id) {
      const existing = await getRow(workspaceId, id);
      await db.deleteFrom('memoryEntries').where('id', '=', existing.id).execute();
      await audit.log({
        workspaceId,
        userId: existing.userId,
        eventType: 'memory.deleted',
        actor: 'user',
        targetType: 'memory_entry',
        targetId: id,
        summary: `Memory deleted (${existing.kind})`,
        metadata: { kind: existing.kind },
      });
    },

    async exportAll(workspaceId) {
      return service.list(workspaceId, { includeDisabled: true });
    },

    async relevant(workspaceId, query, limit = 5) {
      if (!(await service.isEnabled(workspaceId))) return [];
      const rows = await db
        .selectFrom('memoryEntries')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('enabled', '=', 1)
        .execute();
      const queryTokens = tokenize(query);
      const scored = rows
        .map((row) => {
          const contentTokens = tokenize(row.content);
          let overlap = 0;
          for (const t of queryTokens) if (contentTokens.has(t)) overlap += 1;
          return { row, score: overlap + row.confidence, overlap };
        })
        .filter((s) => s.overlap > 0)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          // Recency tiebreak.
          return b.row.updatedAt.localeCompare(a.row.updatedAt);
        })
        .slice(0, limit);

      const now = nowIso();
      if (scored.length > 0) {
        await db
          .updateTable('memoryEntries')
          .set({ lastUsedAt: now })
          .where(
            'id',
            'in',
            scored.map((s) => s.row.id),
          )
          .execute();
      }
      return scored.map((s) => parseMemoryRow({ ...s.row, lastUsedAt: now }));
    },
  };

  return service;
}
