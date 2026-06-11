/**
 * Self-learning routes: the explainability and control surface. Everything
 * Donna has learned is listable, explainable (evidence + reasons), and
 * correctable (confirm / edit / pin / mark wrong / delete). Learning can be
 * disabled entirely, and a manual learning pass can be triggered.
 */
import {
  AUDIENCE_KINDS,
  LEARNING_DOMAINS,
  MIN_ACTIONABLE_CONFIDENCE,
  PREFERENCE_CATEGORIES,
  SOURCE_CATEGORIES,
} from '@donna/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SETTING_KEYS, type AppContext } from '../context.js';
import { badRequest } from '../lib/http-errors.js';

const ScopeSchema = z
  .object({
    domain: z.enum(LEARNING_DOMAINS).optional(),
    audience: z.enum(AUDIENCE_KINDS).optional(),
    channel: z.enum(SOURCE_CATEGORIES).optional(),
    projectId: z.string().optional(),
    personEmail: z.string().email().optional(),
  })
  .strict();

const CreateBody = z.object({
  statement: z.string().min(3).max(2_000),
  category: z.enum(PREFERENCE_CATEGORIES).optional(),
  scope: ScopeSchema.optional(),
});

const CorrectionBody = z.object({
  action: z.enum(['confirm', 'mark_wrong', 'pin', 'unpin', 'edit', 'delete']),
  statement: z.string().min(3).max(2_000).optional(),
  note: z.string().max(2_000).optional(),
});

const DraftFeedbackBody = z.object({
  original: z.string().min(1).max(50_000),
  edited: z.string().min(1).max(50_000),
  audience: z.enum(AUDIENCE_KINDS).optional(),
  channel: z.enum(SOURCE_CATEGORIES).optional(),
  refId: z.string().optional(),
});

const SettingsBody = z.object({ enabled: z.boolean() });

export function registerLearningRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { learning, settings, audit } = ctx.services;

  app.get('/api/learning', async (request) => {
    const query = z
      .object({ category: z.enum(PREFERENCE_CATEGORIES).optional() })
      .parse(request.query ?? {});
    const opts: Parameters<typeof learning.list>[2] = { includeInactive: true };
    if (query.category !== undefined) opts.category = query.category;
    const [preferences, enabled] = await Promise.all([
      learning.list(request.workspaceId, request.userId, opts),
      learning.isEnabled(request.workspaceId),
    ]);
    return { preferences, enabled, actionableConfidence: MIN_ACTIONABLE_CONFIDENCE };
  });

  app.post('/api/learning/preferences', async (request) => {
    const body = CreateBody.safeParse(request.body);
    if (!body.success) throw badRequest('statement is required (3-2000 chars)');
    const input: Parameters<typeof learning.createExplicit>[2] = {
      statement: body.data.statement,
    };
    if (body.data.category !== undefined) input.category = body.data.category;
    if (body.data.scope !== undefined) input.scope = body.data.scope;
    const preference = await learning.createExplicit(request.workspaceId, request.userId, input);
    return { preference };
  });

  app.get('/api/learning/preferences/:id/explain', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return learning.explain(request.workspaceId, id);
  });

  app.post('/api/learning/preferences/:id/correct', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = CorrectionBody.safeParse(request.body);
    if (!body.success) throw badRequest('Invalid correction');
    const correction: Parameters<typeof learning.applyUserCorrection>[3] = {
      action: body.data.action,
    };
    if (body.data.statement !== undefined) correction.statement = body.data.statement;
    if (body.data.note !== undefined) correction.note = body.data.note;
    const preference = await learning.applyUserCorrection(
      request.workspaceId,
      request.userId,
      id,
      correction,
    );
    return { preference };
  });

  app.delete('/api/learning/preferences/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await learning.remove(request.workspaceId, id);
    return { ok: true };
  });

  app.get('/api/learning/search', async (request) => {
    const { q } = z.object({ q: z.string().min(1) }).parse(request.query);
    const preferences = await learning.search(request.workspaceId, request.userId, q);
    return { preferences };
  });

  app.get('/api/learning/contradictions', async (request) => {
    const entries = await learning.detectContradictions(request.workspaceId, request.userId);
    return { contradictions: entries };
  });

  /** Manual learning pass (extract + infer + merge). */
  app.post('/api/learning/run', async (request) => {
    if (!(await learning.isEnabled(request.workspaceId))) {
      throw badRequest('Learning is disabled for this workspace');
    }
    const result = await learning.learnNow(request.workspaceId);
    return result;
  });

  /** Style learning from a user's edit of an AI-generated draft. */
  app.post('/api/learning/draft-feedback', async (request) => {
    const body = DraftFeedbackBody.safeParse(request.body);
    if (!body.success) throw badRequest('original and edited are required');
    const input: Parameters<typeof learning.learnFromDraftEdit>[2] = {
      original: body.data.original,
      edited: body.data.edited,
      audience: body.data.audience ?? 'unknown',
      observedAt: new Date().toISOString(),
    };
    if (body.data.channel !== undefined) input.channel = body.data.channel;
    if (body.data.refId !== undefined) input.refId = body.data.refId;
    const signals = await learning.learnFromDraftEdit(request.workspaceId, request.userId, input);
    return { signals };
  });

  app.put('/api/learning/settings', async (request) => {
    const body = SettingsBody.safeParse(request.body);
    if (!body.success) throw badRequest('enabled must be a boolean');
    await settings.set(request.workspaceId, SETTING_KEYS.learningEnabled, body.data.enabled);
    await audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'learning.toggled',
      actor: 'user',
      targetType: 'setting',
      targetId: SETTING_KEYS.learningEnabled,
      summary: `Self-learning ${body.data.enabled ? 'enabled' : 'disabled'}`,
      metadata: { enabled: body.data.enabled },
    });
    return { enabled: body.data.enabled };
  });
}
