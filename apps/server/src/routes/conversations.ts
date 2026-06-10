/**
 * Conversation & chat routes.
 *
 * CRUD for conversations plus the chat endpoint: POST /:id/messages persists
 * the user message, then streams the assistant reply as Server-Sent Events
 * (delta / citations / actions / approval_created / message / error) by
 * bridging AssistantStreamEvents onto the SSE stream. Per-message auditing is
 * intentionally omitted — LLM call logging covers it without the noise.
 */
import {
  fromJson,
  newId,
  nowIso,
  toJson,
  type Citation,
  type Message,
  type SuggestedAction,
} from '@donna/core';
import type { MessagesTable } from '@donna/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext, AssistantStreamEvent } from '../context.js';
import { badRequest, notFound } from '../lib/http-errors.js';
import { startSse } from '../lib/sse.js';

const CreateBody = z.object({
  title: z.string().max(200).optional(),
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  archived: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});

const MessageBody = z.object({
  content: z.string().min(1).max(8000),
});

const IdParams = z.object({ id: z.string() });

function toFlag(value: boolean | 0 | 1): 0 | 1 {
  return value === true || value === 1 ? 1 : 0;
}

/** Parse a DB message row into the contract Message shape (JSON fields parsed). */
function parseMessageRow(row: MessagesTable): Message {
  return {
    ...row,
    role: row.role as Message['role'],
    status: row.status as Message['status'],
    citations: fromJson<Citation[]>(row.citations, []),
    suggestedActions: fromJson<SuggestedAction[]>(row.suggestedActions, []),
  };
}

export function registerConversationsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const { assistant } = ctx.services;

  async function loadConversation(workspaceId: string, id: string) {
    const conversation = await db
      .selectFrom('conversations')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (conversation === undefined) throw notFound('Conversation not found');
    return conversation;
  }

  // GET /api/conversations — non-archived, most recent activity first.
  app.get('/api/conversations', async (request) => {
    const items = await db
      .selectFrom('conversations')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .where('archived', '=', 0)
      .orderBy('lastMessageAt', 'desc')
      .orderBy('createdAt', 'desc')
      .execute();
    return { items };
  });

  // POST /api/conversations — create (title defaults to 'New conversation').
  app.post('/api/conversations', async (request) => {
    const body = CreateBody.safeParse(request.body ?? {});
    if (!body.success) throw badRequest('Invalid conversation payload');
    const now = nowIso();
    const title = body.data.title?.trim();
    const conversation = {
      id: newId('cnv'),
      workspaceId: request.workspaceId,
      userId: request.userId,
      title: title !== undefined && title !== '' ? title : 'New conversation',
      pinned: 0,
      archived: 0,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insertInto('conversations').values(conversation).execute();
    return { conversation };
  });

  // GET /api/conversations/:id — conversation + messages (oldest first).
  app.get('/api/conversations/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const conversation = await loadConversation(request.workspaceId, id);
    const rows = await db
      .selectFrom('messages')
      .selectAll()
      .where('conversationId', '=', id)
      .where('workspaceId', '=', request.workspaceId)
      .orderBy('createdAt', 'asc')
      .execute();
    return { conversation, messages: rows.map(parseMessageRow) };
  });

  // PATCH /api/conversations/:id — title / pinned / archived.
  app.patch('/api/conversations/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = PatchBody.safeParse(request.body);
    if (!body.success) throw badRequest('Invalid conversation patch');
    await loadConversation(request.workspaceId, id);
    const patch: { title?: string; pinned?: 0 | 1; archived?: 0 | 1; updatedAt: string } = {
      updatedAt: nowIso(),
    };
    if (body.data.title !== undefined) patch.title = body.data.title.trim();
    if (body.data.pinned !== undefined) patch.pinned = toFlag(body.data.pinned);
    if (body.data.archived !== undefined) patch.archived = toFlag(body.data.archived);
    await db.updateTable('conversations').set(patch).where('id', '=', id).execute();
    const conversation = await loadConversation(request.workspaceId, id);
    return { conversation };
  });

  // DELETE /api/conversations/:id — remove conversation and its messages.
  app.delete('/api/conversations/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    await loadConversation(request.workspaceId, id);
    await db
      .deleteFrom('messages')
      .where('conversationId', '=', id)
      .where('workspaceId', '=', request.workspaceId)
      .execute();
    await db.deleteFrom('conversations').where('id', '=', id).execute();
    return { ok: true };
  });

  // POST /api/conversations/:id/messages — persist user message, stream reply via SSE.
  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = MessageBody.safeParse(request.body);
    if (!body.success) throw badRequest('content is required (1-8000 characters)');
    await loadConversation(request.workspaceId, id);

    // Persist the user message before streaming, per contract.
    await db
      .insertInto('messages')
      .values({
        id: newId('msg'),
        conversationId: id,
        workspaceId: request.workspaceId,
        role: 'user',
        content: body.data.content,
        citations: toJson([]),
        suggestedActions: toJson([]),
        status: 'complete',
        modelUsed: null,
        llmCallId: null,
        error: null,
        createdAt: nowIso(),
      })
      .execute();

    reply.hijack();
    const sse = startSse(reply);
    const controller = new AbortController();
    request.raw.on('close', () => {
      controller.abort();
    });

    try {
      await assistant.respond({
        workspaceId: request.workspaceId,
        userId: request.userId,
        conversationId: id,
        abortSignal: controller.signal,
        send: (event: AssistantStreamEvent) => {
          const { type, ...payload } = event;
          sse.send(type, payload);
        },
      });
    } catch (err) {
      // respond() persists its own error message in normal failure modes;
      // this is the last-resort guard so the stream always terminates.
      sse.send('error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      sse.close();
    }
  });
}
