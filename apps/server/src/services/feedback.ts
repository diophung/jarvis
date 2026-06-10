/**
 * Feedback service: records item_feedback rows and applies their side
 * effects — task status updates (done/deferred) and derived user_preferences
 * that feed back into future scoring (important/not-important senders,
 * "more like this" topics). Every recording is audited.
 */
import { fromJson, newId, nowIso, toJson } from '@donna/core';
import type { FeedbackKind, PersonRef } from '@donna/core';
import type { Db } from '@donna/db';
import type { AuditService, FeedbackService } from '../context.js';
import { extractTitleKeywords, FEEDBACK_PREF_KEYS } from './scoring.js';

const DAY_MS = 86_400_000;

interface FeedbackInput {
  kind: FeedbackKind;
  sourceItemId?: string;
  taskCandidateId?: string;
  digestItemId?: string;
  note?: string;
}

export function createFeedbackService(deps: { db: Db; audit: AuditService }): FeedbackService {
  const { db, audit } = deps;

  async function getDerivedArray(
    workspaceId: string,
    userId: string,
    key: string,
  ): Promise<string[]> {
    const row = await db
      .selectFrom('userPreferences')
      .select('value')
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .where('key', '=', key)
      .executeTakeFirst();
    return row ? fromJson<string[]>(row.value, []) : [];
  }

  async function setDerivedArray(
    workspaceId: string,
    userId: string,
    key: string,
    value: string[],
  ): Promise<void> {
    const now = nowIso();
    const existing = await db
      .selectFrom('userPreferences')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .where('key', '=', key)
      .executeTakeFirst();
    if (existing) {
      await db
        .updateTable('userPreferences')
        .set({ value: toJson(value), kind: 'derived', origin: 'feedback', updatedAt: now })
        .where('id', '=', existing.id)
        .execute();
    } else {
      await db
        .insertInto('userPreferences')
        .values({
          id: newId('prf'),
          workspaceId,
          userId,
          key,
          value: toJson(value),
          kind: 'derived',
          origin: 'feedback',
          createdAt: now,
          updatedAt: now,
        })
        .execute();
    }
  }

  /** Resolve the source item for feedback: direct id, or via the task candidate. */
  async function resolveSourceItem(
    workspaceId: string,
    input: FeedbackInput,
  ): Promise<{ id: string; title: string; sender: string | null } | null> {
    let sourceItemId = input.sourceItemId ?? null;
    if (sourceItemId === null && input.taskCandidateId !== undefined) {
      const task = await db
        .selectFrom('taskCandidates')
        .select('sourceItemId')
        .where('workspaceId', '=', workspaceId)
        .where('id', '=', input.taskCandidateId)
        .executeTakeFirst();
      sourceItemId = task?.sourceItemId ?? null;
    }
    if (sourceItemId === null) return null;
    const item = await db
      .selectFrom('sourceItems')
      .select(['id', 'title', 'sender'])
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', sourceItemId)
      .executeTakeFirst();
    return item ?? null;
  }

  return {
    async record(workspaceId, userId, input): Promise<void> {
      const now = nowIso();
      const feedbackId = newId('fbk');
      await db
        .insertInto('itemFeedback')
        .values({
          id: feedbackId,
          workspaceId,
          userId,
          sourceItemId: input.sourceItemId ?? null,
          taskCandidateId: input.taskCandidateId ?? null,
          digestItemId: input.digestItemId ?? null,
          kind: input.kind,
          note: input.note ?? null,
          createdAt: now,
        })
        .execute();

      // Effect: done/deferred updates the task candidate status.
      if ((input.kind === 'done' || input.kind === 'deferred') && input.taskCandidateId !== undefined) {
        const task = await db
          .selectFrom('taskCandidates')
          .select(['id', 'deferredUntil'])
          .where('workspaceId', '=', workspaceId)
          .where('id', '=', input.taskCandidateId)
          .executeTakeFirst();
        if (task) {
          const patch: { status: string; updatedAt: string; deferredUntil?: string } = {
            status: input.kind,
            updatedAt: now,
          };
          if (input.kind === 'deferred' && task.deferredUntil === null) {
            patch.deferredUntil = new Date(Date.parse(now) + DAY_MS).toISOString();
          }
          await db.updateTable('taskCandidates').set(patch).where('id', '=', task.id).execute();
        }
      }

      // Effect: important / not_important maintain disjoint derived sender lists.
      if (input.kind === 'important' || input.kind === 'not_important') {
        const item = await resolveSourceItem(workspaceId, input);
        const senderEmail = item
          ? fromJson<PersonRef | null>(item.sender, null)?.email?.toLowerCase()
          : undefined;
        if (senderEmail !== undefined && senderEmail !== '') {
          const targetKey =
            input.kind === 'important'
              ? FEEDBACK_PREF_KEYS.sendersImportant
              : FEEDBACK_PREF_KEYS.sendersNotImportant;
          const oppositeKey =
            input.kind === 'important'
              ? FEEDBACK_PREF_KEYS.sendersNotImportant
              : FEEDBACK_PREF_KEYS.sendersImportant;
          const target = await getDerivedArray(workspaceId, userId, targetKey);
          if (!target.includes(senderEmail)) {
            await setDerivedArray(workspaceId, userId, targetKey, [...target, senderEmail]);
          }
          const opposite = await getDerivedArray(workspaceId, userId, oppositeKey);
          if (opposite.includes(senderEmail)) {
            await setDerivedArray(
              workspaceId,
              userId,
              oppositeKey,
              opposite.filter((e) => e !== senderEmail),
            );
          }
        }
      }

      // Effect: more_like_this appends title keywords to a derived topic list.
      if (input.kind === 'more_like_this') {
        const item = await resolveSourceItem(workspaceId, input);
        if (item) {
          const keywords = extractTitleKeywords(item.title, 3);
          if (keywords.length > 0) {
            const current = await getDerivedArray(
              workspaceId,
              userId,
              FEEDBACK_PREF_KEYS.topicsMoreLikeThis,
            );
            const merged = [...current];
            for (const keyword of keywords) {
              if (!merged.includes(keyword)) merged.push(keyword);
            }
            if (merged.length !== current.length) {
              await setDerivedArray(
                workspaceId,
                userId,
                FEEDBACK_PREF_KEYS.topicsMoreLikeThis,
                merged,
              );
            }
          }
        }
      }

      await audit.log({
        workspaceId,
        userId,
        eventType: 'feedback.recorded',
        actor: 'user',
        targetType: input.taskCandidateId !== undefined ? 'task_candidate' : 'source_item',
        targetId: input.taskCandidateId ?? input.sourceItemId ?? input.digestItemId ?? feedbackId,
        summary: `Feedback recorded: ${input.kind}`,
        metadata: { kind: input.kind },
      });
    },
  };
}
