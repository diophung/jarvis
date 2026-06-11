/**
 * Learning service: the IO half of the self-learning subsystem. Owns signal
 * persistence (privacy-guarded), batch extraction from synced data, the
 * inference run, decay, and the user-facing preference management APIs
 * (list / explain / correct / pin / delete / search / merge / contradictions).
 *
 * All actual learning logic is pure and lives in @donna/core/learning; this
 * service feeds it data and persists its output. Every mutation is audited —
 * no hidden profiling.
 */
import {
  contradictionReport,
  decayConfidence as decayConfidenceMath,
  extractActionDecisionSignal,
  extractCalendarDensitySignals,
  extractDraftEditSignals,
  extractExplicitStatementSignals,
  extractFeedbackSignals,
  extractItemSignals,
  extractThreadReplySignals,
  fromJson,
  inferPreferences,
  isSafeToLearn,
  mergeSimilarPreferences,
  newId,
  nowIso,
  ORIGIN_BASE_CONFIDENCE,
  RETIREMENT_THRESHOLD,
  scopeKey,
  toJson,
  type ContradictionReportEntry,
  type ExtractionContext,
  type LearnableItem,
  type LearnedPreference,
  type LearningScope,
  type LearningSignal,
  type LearningSignalInput,
  type PersonContext,
  type PersonRef,
  type PreferenceCategory,
  type PreferenceDraft,
  type SourceCategory,
} from '@donna/core';
import type { Db, LearnedPreferencesTable, LearningSignalsTable, SourceItemsTable } from '@donna/db';
import {
  SETTING_KEYS,
  type AuditService,
  type CacheService,
  type LearningService,
  type SettingsService,
} from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';
import { cacheKey } from './cache.js';

const DAY_MS = 86_400_000;
/** Extraction looks back this far for thread context on the first run. */
const EXTRACTION_WINDOW_DAYS = 30;
/** Cap of items considered per extraction run. */
const MAX_ITEMS_PER_RUN = 2000;
/** Cap of pending signals consumed per inference run. */
const MAX_SIGNALS_PER_RUN = 1000;
/** Pending signals older than this are pruned (they never settled into a preference). */
const PENDING_SIGNAL_TTL_DAYS = 180;
/** Backpressure cap: skip extraction while this many signals await inference. */
const MAX_PENDING_SIGNALS = 5_000;

const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
]);

export function parseSignalRow(row: LearningSignalsTable): LearningSignal {
  return {
    ...row,
    kind: row.kind as LearningSignal['kind'],
    scope: fromJson<LearningScope>(row.scope, {}),
    source: fromJson<LearningSignal['source']>(row.source, {
      sourceType: 'source_item',
      observedAt: row.observedAt,
    }),
  };
}

export function parsePreferenceRow(row: LearnedPreferencesTable): LearnedPreference {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    category: row.category as LearnedPreference['category'],
    key: row.key,
    value: row.value,
    statement: row.statement,
    scope: fromJson<LearningScope>(row.scope, {}),
    origin: row.origin as LearnedPreference['origin'],
    status: row.status as LearnedPreference['status'],
    confidence: row.confidence,
    evidenceCount: row.evidenceCount,
    evidenceWeight: row.evidenceWeight,
    contradictionCount: row.contradictionCount,
    pinned: row.pinned,
    decayHalfLifeDays: row.decayHalfLifeDays,
    lastReinforcedAt: row.lastReinforcedAt,
    explanation: row.explanation,
    sources: fromJson<LearnedPreference['sources']>(row.sources, []),
    contradictions: fromJson<LearnedPreference['contradictions']>(row.contradictions, []),
    userNote: row.userNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function preferenceColumns(pref: LearnedPreference): Omit<LearnedPreferencesTable, 'id' | 'createdAt'> {
  return {
    workspaceId: pref.workspaceId,
    userId: pref.userId,
    category: pref.category,
    key: pref.key,
    value: pref.value,
    statement: pref.statement,
    scope: toJson(pref.scope),
    scopeKey: scopeKey(pref.scope),
    origin: pref.origin,
    status: pref.status,
    confidence: pref.confidence,
    evidenceCount: pref.evidenceCount,
    evidenceWeight: pref.evidenceWeight,
    contradictionCount: pref.contradictionCount,
    pinned: pref.pinned,
    decayHalfLifeDays: pref.decayHalfLifeDays,
    lastReinforcedAt: pref.lastReinforcedAt,
    explanation: pref.explanation,
    sources: toJson(pref.sources),
    contradictions: toJson(pref.contradictions),
    userNote: pref.userNote,
    updatedAt: pref.updatedAt,
  };
}

function toLearnable(row: SourceItemsTable): LearnableItem {
  return {
    id: row.id,
    category: row.category as SourceCategory,
    provider: row.provider,
    title: row.title,
    bodyText: row.bodyText,
    snippet: row.snippet,
    sender: fromJson<PersonRef | null>(row.sender, null),
    participants: fromJson<PersonRef[]>(row.participants, []),
    itemTimestamp: row.itemTimestamp,
    dueAt: row.dueAt,
    startsAt: row.startsAt,
    threadExternalId: row.threadExternalId,
    isRead: row.isRead,
  };
}

/** Stable identity of a signal observation, for idempotent re-extraction. */
function signalFingerprint(s: {
  kind: string;
  key: string;
  value: string;
  source: { sourceType: string; refId?: string };
}): string {
  return `${s.kind}|${s.key}|${s.value}|${s.source.sourceType}|${s.source.refId ?? ''}`;
}

/** Active-preference lists are the personalization hot read; cache briefly. */
const PREFS_CACHE_TTL_SECONDS = 60;

export function createLearningService(deps: {
  db: Db;
  settings: SettingsService;
  audit: AuditService;
  cache?: CacheService;
}): LearningService {
  const { db, settings, audit, cache } = deps;

  function prefsCacheKey(workspaceId: string, userId: string): string {
    return cacheKey(workspaceId, 'lprefs', userId);
  }

  /** Every preference mutation invalidates the per-user hot list. */
  async function invalidatePrefs(workspaceId: string, userId: string): Promise<void> {
    await cache?.del(prefsCacheKey(workspaceId, userId));
  }

  async function getRow(workspaceId: string, id: string): Promise<LearnedPreferencesTable> {
    const row = await db
      .selectFrom('learnedPreferences')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!row) throw notFound('Learned preference not found');
    return row;
  }

  async function buildExtractionContext(workspaceId: string, now: string): Promise<ExtractionContext> {
    const ownerRows = await db
      .selectFrom('workspaces')
      .innerJoin('users', 'users.id', 'workspaces.ownerUserId')
      .select('users.email as email')
      .where('workspaces.id', '=', workspaceId)
      .execute();
    const peopleRows = await db
      .selectFrom('people')
      .select(['emails', 'isSelf', 'importance', 'title'])
      .where('workspaceId', '=', workspaceId)
      .execute();

    const selfEmails = new Set<string>(ownerRows.map((r) => r.email.toLowerCase()));
    for (const p of peopleRows) {
      if (p.isSelf === 1) {
        for (const e of fromJson<string[]>(p.emails, [])) selfEmails.add(e.toLowerCase());
      }
    }
    // Freemail domains are excluded from "self domains" so a personal gmail
    // user does not classify every gmail correspondent as 'team'.
    const selfDomains = [...selfEmails]
      .map((e) => e.slice(e.lastIndexOf('@') + 1))
      .filter((d) => d !== '' && !FREEMAIL_DOMAINS.has(d));

    const people: Record<string, PersonContext> = {};
    for (const p of peopleRows) {
      for (const email of fromJson<string[]>(p.emails, [])) {
        people[email.toLowerCase()] = {
          email: email.toLowerCase(),
          importance: p.importance as PersonContext['importance'],
          title: p.title,
        };
      }
    }
    return { now, selfEmails: [...selfEmails], selfDomains: [...new Set(selfDomains)], people };
  }

  /** Persist signals: privacy guard, then fingerprint-dedupe against stored signals. */
  async function persistSignals(
    workspaceId: string,
    userId: string,
    inputs: LearningSignalInput[],
  ): Promise<number> {
    if (inputs.length === 0) return 0;

    // Privacy guard: never store signals touching sensitive attributes
    // (protected classes, health, politics, religion, sexuality, …).
    const safe = inputs.filter((s) => isSafeToLearn([s.detail, s.source.note, s.key, s.value]));
    if (safe.length === 0) return 0;

    const minObserved = safe.map((s) => s.observedAt).sort()[0] ?? nowIso();
    const existingRows = await db
      .selectFrom('learningSignals')
      .select(['kind', 'key', 'value', 'source'])
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .where('observedAt', '>=', minObserved)
      .execute();
    const seen = new Set(
      existingRows.map((r) =>
        signalFingerprint({ ...r, source: fromJson<{ sourceType: string; refId?: string }>(r.source, { sourceType: '' }) }),
      ),
    );

    const now = nowIso();
    let stored = 0;
    for (const input of safe) {
      const fp = signalFingerprint(input);
      if (seen.has(fp)) continue;
      seen.add(fp);
      await db
        .insertInto('learningSignals')
        .values({
          id: newId('sig'),
          workspaceId,
          userId,
          kind: input.kind,
          key: input.key,
          value: input.value,
          strength: input.strength,
          scope: toJson(input.scope),
          detail: input.detail,
          source: toJson(input.source),
          observedAt: input.observedAt,
          processed: 0,
          createdAt: now,
        })
        .execute();
      stored += 1;
    }
    return stored;
  }

  const service: LearningService = {
    async isEnabled(workspaceId) {
      return settings.get<boolean>(workspaceId, SETTING_KEYS.learningEnabled, true);
    },

    async recordSignals(workspaceId, userId, signals) {
      if (!(await service.isEnabled(workspaceId))) return 0;
      return persistSignals(workspaceId, userId, signals);
    },

    async extractFromSources(workspaceId) {
      if (!(await service.isEnabled(workspaceId))) return { signals: 0 };
      // Backpressure: when inference cannot keep up (pending backlog beyond
      // the cap), stop producing new signals instead of growing the table
      // unboundedly. Extraction is idempotent, so skipped windows are
      // recovered on a later run once the backlog drains.
      const pending = await db
        .selectFrom('learningSignals')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('workspaceId', '=', workspaceId)
        .where('processed', '=', 0)
        .executeTakeFirst();
      if (Number(pending?.n ?? 0) >= MAX_PENDING_SIGNALS) {
        console.warn(
          `[learning] backpressure: ${Number(pending?.n ?? 0)} pending signals in ${workspaceId}; skipping extraction`,
        );
        return { signals: 0 };
      }
      const now = nowIso();
      const windowStart = new Date(Date.parse(now) - EXTRACTION_WINDOW_DAYS * DAY_MS).toISOString();
      const ctx = await buildExtractionContext(workspaceId, now);

      const owner = await db
        .selectFrom('workspaces')
        .select('ownerUserId')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      if (!owner) return { signals: 0 };
      const userId = owner.ownerUserId;

      const itemRows = await db
        .selectFrom('sourceItems')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('itemTimestamp', '>=', windowStart)
        .orderBy('itemTimestamp', 'desc')
        .limit(MAX_ITEMS_PER_RUN)
        .execute();
      const items = itemRows.map(toLearnable);

      const watermark = await settings.get<string | null>(
        workspaceId,
        SETTING_KEYS.learningLastExtractedAt,
        null,
      );
      // Per-item signals only for items newer than the watermark; thread and
      // calendar extraction always runs over the full window (the fingerprint
      // dedupe in persistSignals keeps re-extraction idempotent).
      const newItems =
        watermark === null ? items : items.filter((i) => i.itemTimestamp > watermark);

      const inputs: LearningSignalInput[] = [
        ...newItems.flatMap((item) => extractItemSignals(item, ctx)),
        ...extractThreadReplySignals(items, ctx),
        ...extractCalendarDensitySignals(items, ctx),
      ];

      // Approval decisions since the watermark: revealed trust preferences.
      let approvalsQuery = db
        .selectFrom('approvalRequests')
        .select(['id', 'capability', 'status', 'decidedAt'])
        .where('workspaceId', '=', workspaceId)
        .where('status', 'in', ['approved', 'denied'])
        .where('decidedAt', 'is not', null);
      if (watermark !== null) approvalsQuery = approvalsQuery.where('decidedAt', '>', watermark);
      const approvalRows = await approvalsQuery.execute();
      for (const row of approvalRows) {
        inputs.push(
          extractActionDecisionSignal({
            capability: row.capability,
            decision: row.status as 'approved' | 'denied',
            refId: row.id,
            observedAt: row.decidedAt ?? now,
          }),
        );
      }

      const stored = await persistSignals(workspaceId, userId, inputs);
      await settings.set(workspaceId, SETTING_KEYS.learningLastExtractedAt, now);
      return { signals: stored };
    },

    async runInference(workspaceId) {
      if (!(await service.isEnabled(workspaceId))) return { created: 0, updated: 0 };
      const now = nowIso();
      const signalRows = await db
        .selectFrom('learningSignals')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('processed', '=', 0)
        .orderBy('observedAt', 'asc')
        .limit(MAX_SIGNALS_PER_RUN)
        .execute();
      if (signalRows.length === 0) return { created: 0, updated: 0 };

      const byUser = new Map<string, LearningSignal[]>();
      for (const row of signalRows) {
        const list = byUser.get(row.userId) ?? [];
        list.push(parseSignalRow(row));
        byUser.set(row.userId, list);
      }

      let created = 0;
      let updated = 0;
      for (const [userId, signals] of byUser) {
        const existingRows = await db
          .selectFrom('learnedPreferences')
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .where('userId', '=', userId)
          .execute();
        const existing = existingRows.map(parsePreferenceRow);

        const result = inferPreferences({ now, signals, existing });

        for (const draft of result.created) {
          await insertPreference(workspaceId, userId, draft, now);
          created += 1;
        }
        for (const pref of result.updated) {
          await db
            .updateTable('learnedPreferences')
            .set(preferenceColumns(pref))
            .where('id', '=', pref.id)
            .execute();
          updated += 1;
        }
        if (result.consumedSignalIds.length > 0) {
          await db
            .updateTable('learningSignals')
            .set({ processed: 1 })
            .where('id', 'in', result.consumedSignalIds)
            .execute();
        }
        if (result.created.length > 0 || result.updated.length > 0) {
          await invalidatePrefs(workspaceId, userId);
        }
      }
      return { created, updated };
    },

    async learnNow(workspaceId) {
      const { signals } = await service.extractFromSources(workspaceId);
      const { created, updated } = await service.runInference(workspaceId);
      const owner = await db
        .selectFrom('workspaces')
        .select('ownerUserId')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      let merged = 0;
      if (owner) {
        merged = (await service.mergeSimilar(workspaceId, owner.ownerUserId)).merged;
      }
      await audit.log({
        workspaceId,
        userId: owner?.ownerUserId ?? null,
        eventType: 'learning.run',
        actor: 'system',
        summary: `Learning run: ${signals} new signals, ${created} preferences created, ${updated} updated, ${merged} merged`,
        metadata: { signals, created, updated, merged },
      });
      return { signals, created, updated };
    },

    async decayConfidence(workspaceId) {
      const now = nowIso();
      const rows = await db
        .selectFrom('learnedPreferences')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('status', '=', 'active')
        .execute();
      let decayed = 0;
      let retired = 0;
      for (const row of rows) {
        const next = decayConfidenceMath({
          confidence: row.confidence,
          lastReinforcedAt: row.lastReinforcedAt,
          now,
          decayHalfLifeDays: row.decayHalfLifeDays,
          pinned: row.pinned === 1,
        });
        if (Math.abs(next - row.confidence) < 0.001) continue;
        // Explicit preferences decay (slowly) but are never auto-retired:
        // the user's word stands until they remove it.
        const retire =
          next < RETIREMENT_THRESHOLD && row.pinned !== 1 && row.origin !== 'explicit';
        await db
          .updateTable('learnedPreferences')
          .set({ confidence: next, status: retire ? 'retired' : row.status, updatedAt: now })
          .where('id', '=', row.id)
          .execute();
        await invalidatePrefs(workspaceId, row.userId);
        decayed += 1;
        if (retire) retired += 1;
      }

      // Prune pending signals that never settled into a preference.
      const ttl = new Date(Date.parse(now) - PENDING_SIGNAL_TTL_DAYS * DAY_MS).toISOString();
      await db
        .deleteFrom('learningSignals')
        .where('workspaceId', '=', workspaceId)
        .where('processed', '=', 0)
        .where('observedAt', '<', ttl)
        .execute();

      return { decayed, retired };
    },

    async list(workspaceId, userId, opts = {}) {
      const load = async (): Promise<LearnedPreferencesTable[]> => {
        let q = db
          .selectFrom('learnedPreferences')
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .where('userId', '=', userId)
          .orderBy('confidence', 'desc');
        if (!opts.includeInactive) q = q.where('status', '=', 'active');
        if (opts.category !== undefined) q = q.where('category', '=', opts.category);
        return q.execute();
      };
      // Only the hot personalization shape (active, unfiltered) is cached —
      // the cache is disposable and short-lived (see services/cache.ts).
      const cacheable = cache !== undefined && !opts.includeInactive && opts.category === undefined;
      const rows = cacheable
        ? await cache.withCache(prefsCacheKey(workspaceId, userId), PREFS_CACHE_TTL_SECONDS, load)
        : await load();
      return rows.map(parsePreferenceRow);
    },

    async get(workspaceId, id) {
      const row = await db
        .selectFrom('learnedPreferences')
        .selectAll()
        .where('id', '=', id)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();
      return row ? parsePreferenceRow(row) : null;
    },

    async explain(workspaceId, id) {
      const row = await getRow(workspaceId, id);
      const preference = parsePreferenceRow(row);
      const recentRows = await db
        .selectFrom('learningSignals')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('userId', '=', row.userId)
        .where('key', '=', row.key)
        .orderBy('observedAt', 'desc')
        .limit(20)
        .execute();
      // Only signals from the same scope explain this preference.
      const sk = scopeKey(preference.scope);
      const recentSignals = recentRows
        .map(parseSignalRow)
        .filter((s) => scopeKey(s.scope) === sk);
      return { preference, recentSignals };
    },

    async getPreferencesByContext(workspaceId, userId, context) {
      const prefs = await service.list(workspaceId, userId);
      // Scope match: every set field of the preference scope must match the
      // context. Sorted by specificity so callers can let the most specific
      // preference win (context-dependent behavior).
      const matches = prefs
        .map((pref) => {
          let specificity = 0;
          for (const [field, value] of Object.entries(pref.scope)) {
            if (value === undefined) continue;
            if (context[field as keyof LearningScope] !== value) return null;
            specificity += 1;
          }
          return { pref, specificity };
        })
        .filter((m): m is { pref: LearnedPreference; specificity: number } => m !== null)
        .sort((a, b) => a.specificity - b.specificity || a.pref.confidence - b.pref.confidence);
      return matches.map((m) => m.pref);
    },

    async search(workspaceId, userId, query) {
      const prefs = await service.list(workspaceId, userId, { includeInactive: true });
      const tokens = query
        .toLowerCase()
        .split(/[^a-z0-9@.]+/)
        .filter((t) => t.length >= 3);
      if (tokens.length === 0) return [];
      return prefs.filter((p) => {
        const haystack = `${p.statement} ${p.key} ${p.value} ${p.category}`.toLowerCase();
        return tokens.some((t) => haystack.includes(t));
      });
    },

    async createExplicit(workspaceId, userId, input) {
      const now = nowIso();
      if (!isSafeToLearn([input.statement])) {
        // Privacy: sensitive attributes are not stored even when volunteered
        // through this API — the user keeps such facts in normal memory
        // entries they fully control, not in the behavioral model.
        throw badRequestSensitive();
      }
      // Try to parse a structured preference so it aggregates with behavior.
      const parsed = extractExplicitStatementSignals({
        text: input.statement,
        sourceType: 'user_command',
        observedAt: now,
      })[0];
      const key = parsed?.key ?? `custom:${newId('lpr').slice(4, 12)}`;
      const value = parsed?.value ?? 'stated';
      const scope = input.scope ?? {};
      const category = input.category ?? 'workflow';

      const draft: PreferenceDraft = {
        category: parsed !== undefined ? inferCategory(parsed.key, category) : category,
        key,
        value,
        statement: input.statement,
        scope,
        origin: 'explicit',
        status: 'active',
        confidence: ORIGIN_BASE_CONFIDENCE.explicit,
        evidenceCount: 1,
        evidenceWeight: 1,
        contradictionCount: 0,
        pinned: 0,
        decayHalfLifeDays: 365,
        lastReinforcedAt: now,
        explanation: 'You told Donna this directly. Correct or delete it anytime.',
        sources: [{ sourceType: 'user_command', observedAt: now, note: 'Stated in preference settings' }],
        contradictions: [],
        userNote: null,
      };

      // Upsert against an existing preference for the same key + scope.
      const existing = await db
        .selectFrom('learnedPreferences')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('userId', '=', userId)
        .where('key', '=', key)
        .where('scopeKey', '=', scopeKey(scope))
        .executeTakeFirst();
      let id: string;
      if (existing) {
        id = existing.id;
        const merged: LearnedPreference = {
          ...parsePreferenceRow(existing),
          ...draft,
          id,
          workspaceId,
          userId,
          createdAt: existing.createdAt,
          updatedAt: now,
        };
        await db
          .updateTable('learnedPreferences')
          .set(preferenceColumns(merged))
          .where('id', '=', id)
          .execute();
      } else {
        id = await insertPreference(workspaceId, userId, draft, now);
      }
      await invalidatePrefs(workspaceId, userId);
      await audit.log({
        workspaceId,
        userId,
        eventType: 'learning.preference.created',
        actor: 'user',
        targetType: 'learned_preference',
        targetId: id,
        summary: `Explicit preference stated: ${input.statement.slice(0, 120)}`,
        metadata: { key, origin: 'explicit' },
      });
      const row = await getRow(workspaceId, id);
      return parsePreferenceRow(row);
    },

    async applyUserCorrection(workspaceId, userId, preferenceId, correction) {
      const row = await getRow(workspaceId, preferenceId);
      const now = nowIso();

      if (correction.action === 'delete') {
        await service.remove(workspaceId, preferenceId);
        return null;
      }

      const patch: Partial<LearnedPreferencesTable> = { updatedAt: now };
      let summary: string;
      switch (correction.action) {
        case 'confirm':
          // Explicit confirmation upgrades the preference to explicit origin
          // (explicit > inferred) and reinforces it.
          patch.origin = 'explicit';
          patch.status = 'active';
          patch.confidence = Math.max(row.confidence, ORIGIN_BASE_CONFIDENCE.explicit);
          patch.evidenceCount = row.evidenceCount + 1;
          patch.evidenceWeight = row.evidenceWeight + 1;
          patch.decayHalfLifeDays = 365;
          patch.lastReinforcedAt = now;
          patch.explanation = `You confirmed this on ${now.slice(0, 10)}. ${row.explanation}`;
          summary = 'Preference confirmed by user';
          break;
        case 'mark_wrong':
          // Marked wrong: disabled AND remembered as rejected so behavior
          // signals never silently re-learn it.
          patch.status = 'rejected';
          patch.confidence = 0;
          summary = 'Preference marked wrong by user';
          break;
        case 'pin':
          patch.pinned = 1;
          summary = 'Preference pinned (exempt from decay)';
          break;
        case 'unpin':
          patch.pinned = 0;
          summary = 'Preference unpinned';
          break;
        case 'edit': {
          const statement = correction.statement?.trim();
          if (statement === undefined || statement === '') {
            throw badRequest('statement is required to edit a preference');
          }
          if (!isSafeToLearn([statement])) throw badRequestSensitive();
          patch.statement = statement;
          patch.origin = 'explicit';
          patch.status = 'active';
          patch.confidence = Math.max(row.confidence, ORIGIN_BASE_CONFIDENCE.explicit);
          patch.explanation = `You edited this preference on ${now.slice(0, 10)}.`;
          summary = 'Preference edited by user';
          break;
        }
      }
      if (correction.note !== undefined) patch.userNote = correction.note;

      await db.updateTable('learnedPreferences').set(patch).where('id', '=', row.id).execute();
      await invalidatePrefs(workspaceId, row.userId);
      await audit.log({
        workspaceId,
        userId,
        eventType: 'learning.preference.corrected',
        actor: 'user',
        targetType: 'learned_preference',
        targetId: preferenceId,
        summary,
        metadata: { action: correction.action },
      });
      const updated = await getRow(workspaceId, preferenceId);
      return parsePreferenceRow(updated);
    },

    async remove(workspaceId, id) {
      const row = await getRow(workspaceId, id);
      await db.deleteFrom('learnedPreferences').where('id', '=', row.id).execute();
      await invalidatePrefs(workspaceId, row.userId);
      // Forget the evidence trail too: signals that fed this preference.
      await db
        .deleteFrom('learningSignals')
        .where('workspaceId', '=', workspaceId)
        .where('userId', '=', row.userId)
        .where('key', '=', row.key)
        .execute();
      await audit.log({
        workspaceId,
        userId: row.userId,
        eventType: 'learning.preference.deleted',
        actor: 'user',
        targetType: 'learned_preference',
        targetId: id,
        summary: `Learned preference deleted (${row.category})`,
        metadata: { key: row.key },
      });
    },

    async mergeSimilar(workspaceId, userId) {
      const prefs = await service.list(workspaceId, userId);
      const now = nowIso();
      const { merged, absorbedIds } = mergeSimilarPreferences(prefs, now);
      for (const pref of merged) {
        await db
          .updateTable('learnedPreferences')
          .set(preferenceColumns(pref))
          .where('id', '=', pref.id)
          .execute();
      }
      if (absorbedIds.length > 0) {
        await db.deleteFrom('learnedPreferences').where('id', 'in', absorbedIds).execute();
      }
      if (merged.length > 0 || absorbedIds.length > 0) await invalidatePrefs(workspaceId, userId);
      return { merged: absorbedIds.length };
    },

    async detectContradictions(workspaceId, userId): Promise<ContradictionReportEntry[]> {
      const prefs = await service.list(workspaceId, userId);
      return contradictionReport(prefs);
    },

    async learnFromFeedback(workspaceId, userId, observation) {
      if (!(await service.isEnabled(workspaceId))) return;
      const signals = extractFeedbackSignals(observation);
      await persistSignals(workspaceId, userId, signals);
    },

    async learnFromDraftEdit(workspaceId, userId, input) {
      if (!(await service.isEnabled(workspaceId))) return 0;
      const signals = extractDraftEditSignals(input);
      return persistSignals(workspaceId, userId, signals);
    },

    async learnFromText(workspaceId, userId, input) {
      if (!(await service.isEnabled(workspaceId))) return 0;
      const signals = extractExplicitStatementSignals(input);
      const stored = await persistSignals(workspaceId, userId, signals);
      // Explicit statements should take effect immediately, not on the next
      // worker tick (explicit feedback has the highest weight).
      if (stored > 0) await service.runInference(workspaceId);
      return stored;
    },
  };

  async function insertPreference(
    workspaceId: string,
    userId: string,
    draft: PreferenceDraft,
    now: string,
  ): Promise<string> {
    const id = newId('lpr');
    await db
      .insertInto('learnedPreferences')
      .values({
        id,
        createdAt: now,
        ...preferenceColumns({
          ...draft,
          id,
          workspaceId,
          userId,
          createdAt: now,
          updatedAt: now,
        }),
      })
      .execute();
    await invalidatePrefs(workspaceId, userId);
    await audit.log({
      workspaceId,
      userId,
      eventType: 'learning.preference.created',
      actor: 'agent',
      targetType: 'learned_preference',
      targetId: id,
      summary: `Learned: ${draft.statement.slice(0, 120)}`,
      metadata: { key: draft.key, origin: draft.origin, confidence: draft.confidence },
    });
    return id;
  }

  return service;
}

function inferCategory(key: string, fallback: PreferenceCategory): PreferenceCategory {
  if (key.startsWith('style.')) return 'communication_style';
  if (key.startsWith('format.')) return 'format';
  if (key.startsWith('person.')) return 'people';
  if (key.startsWith('topic.')) return 'topics';
  return fallback;
}

function badRequestSensitive() {
  return badRequest(
    'This statement touches a sensitive attribute Donna does not learn (health, politics, religion, or similar). Use a regular memory note instead.',
    'sensitive_attribute',
  );
}
