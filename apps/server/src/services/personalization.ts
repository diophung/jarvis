/**
 * Personalization service: resolves the output configuration for a task from
 * the user's learned preferences (pure resolution in @jarvis/core), enriched
 * with live context — currently calendar density as a cognitive-load hint.
 *
 * Always returns both the config AND the applied preferences with reasons,
 * so every personalized surface can show "why Jarvis chose this".
 */
import { nowIso, resolvePersonalization } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import type { LearningService, PersonalizationService } from '../context.js';

const HOUR_MS = 3_600_000;
/** Meetings in the next 24h at/above which the user counts as busy right now. */
const BUSY_EVENT_THRESHOLD = 5;

export function createPersonalizationService(deps: {
  db: Db;
  learning: LearningService;
}): PersonalizationService {
  const { db, learning } = deps;

  /**
   * Live overload check (cognitive load theory): contextual state computed
   * fresh each time, deliberately never stored as a trait.
   */
  async function isBusyNow(workspaceId: string): Promise<boolean> {
    const now = nowIso();
    const dayAhead = new Date(Date.parse(now) + 24 * HOUR_MS).toISOString();
    const row = await db
      .selectFrom('sourceItems')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('workspaceId', '=', workspaceId)
      .where('category', '=', 'calendar')
      .where('startsAt', '>=', now)
      .where('startsAt', '<', dayAhead)
      .executeTakeFirst();
    return Number(row?.n ?? 0) >= BUSY_EVENT_THRESHOLD;
  }

  return {
    async forTask(workspaceId, userId, req) {
      if (!(await learning.isEnabled(workspaceId))) {
        return resolvePersonalization([], { ...req, userBusy: req.userBusy ?? false });
      }
      const context: Parameters<LearningService['getPreferencesByContext']>[2] = {};
      if (req.audience !== undefined) context.audience = req.audience;
      if (req.domain !== undefined) context.domain = req.domain;
      if (req.channel !== undefined) context.channel = req.channel;
      if (req.personEmail !== undefined) context.personEmail = req.personEmail.toLowerCase();

      const preferences = await learning.getPreferencesByContext(workspaceId, userId, context);
      const userBusy = req.userBusy ?? (await isBusyNow(workspaceId));
      return resolvePersonalization(preferences, { ...req, userBusy });
    },
  };
}
