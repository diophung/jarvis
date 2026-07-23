import {
  newId,
  nowIso,
  toJson,
  type AgentAction,
  type MemoryEntry,
} from '@jarvis/core';
import type { Db } from '@jarvis/db';
import { createMockAdapter, LlmClient } from '@jarvis/llm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionsService,
  AssistantService,
  AssistantStreamEvent,
  LlmRouterService,
  MemoryService,
  ProposeActionInput,
  RetrievalService,
  RoutedLlm,
} from '../context.js';
import { createTestDb, seedWorkspace } from '../test/helpers.js';
import { createAuditService } from './audit.js';
import { createAssistantService } from './assistant.js';
import { createSettingsService } from './settings.js';

let db: Db;
let workspaceId: string;
let userId: string;
let conversationId: string;
let assistant: AssistantService;
let proposeCalls: ProposeActionInput[];
let memoryCreate: ReturnType<typeof vi.fn>;
let contractItemId: string;
let contractTaskId: string;
let budgetTaskId: string;

function makeRoutedMock(): RoutedLlm {
  return {
    client: new LlmClient(createMockAdapter()),
    model: 'mock-model',
    params: {},
    providerConfigId: null,
    providerName: 'Demo',
    kind: 'mock',
    isLocal: true,
    isMock: true,
  };
}

function makeLlmStub(): LlmRouterService {
  return {
    clientForTask: async () => makeRoutedMock(),
    embeddingClient: async () => null,
    healthCheck: async () => ({ ok: true, latencyMs: 0, message: 'ok' }),
    listModels: async () => [],
    status: async () => ({
      demoMode: true,
      tasks: { chat: null, summarization: null, digest: null, classification: null, embedding: null },
    }),
  };
}

function makeMemoryStub(): MemoryService {
  memoryCreate = vi.fn(
    async (
      wsId: string,
      uid: string,
      input: { kind: MemoryEntry['kind']; content: string; origin: MemoryEntry['origin']; confidence?: number; provenance?: Record<string, unknown> },
    ): Promise<MemoryEntry> => {
      const now = nowIso();
      return {
        id: newId('mem'),
        workspaceId: wsId,
        userId: uid,
        kind: input.kind,
        content: input.content,
        origin: input.origin,
        confidence: input.confidence ?? 0.5,
        enabled: 1,
        relatedPeopleIds: [],
        relatedProjectIds: [],
        provenance: input.provenance ?? {},
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },
  );
  return {
    isEnabled: async () => true,
    list: async () => [],
    create: memoryCreate as unknown as MemoryService['create'],
    update: async () => {
      throw new Error('not implemented');
    },
    remove: async () => {},
    exportAll: async () => [],
    relevant: async () => [],
  };
}

function makeActionsStub(): ActionsService {
  proposeCalls = [];
  return {
    propose: async (input) => {
      proposeCalls.push(input);
      const now = nowIso();
      const action: AgentAction = {
        id: newId('act'),
        workspaceId: input.workspaceId,
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        capability: input.capability,
        actionType: input.actionType,
        params: input.params,
        target: input.target,
        status: 'executed',
        riskLevel: 'low',
        policyId: null,
        approvalRequestId: null,
        result: null,
        error: null,
        executedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      return {
        action,
        decision: {
          effect: 'auto_approve',
          riskLevel: 'low',
          matchedPolicyId: null,
          reason: 'test auto-approval',
          unknownCapability: false,
        },
        approval: null,
      };
    },
    execute: async () => {
      throw new Error('not implemented');
    },
    decideApproval: async () => {
      throw new Error('not implemented');
    },
    listApprovals: async () => [],
    riskFor: () => 'low',
  };
}

function makeRetrievalStub(): RetrievalService {
  return {
    search: async () => ({
      results: [
        {
          chunkId: newId('chk'),
          sourceType: 'source_item',
          refId: contractItemId,
          title: 'Contract renewal: legal review needed',
          snippet: 'Jin needs the contract redlines reviewed before Friday.',
          score: 1,
          matchType: 'keyword',
          sourceLabel: 'mock-email',
          category: 'email',
        },
      ],
      mode: 'keyword',
    }),
  };
}

async function seedData(): Promise<void> {
  const now = nowIso();
  const accountId = newId('acc');
  await db
    .insertInto('sourceAccounts')
    .values({
      id: accountId,
      workspaceId,
      userId,
      provider: 'mock-email',
      category: 'email',
      displayName: 'Mock Email',
      status: 'connected',
      authRef: null,
      scopes: toJson([]),
      capabilities: toJson([]),
      settings: toJson({}),
      lastSyncAt: null,
      syncCursor: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  contractItemId = newId('itm');
  const budgetItemId = newId('itm');
  const baseItem = {
    workspaceId,
    accountId,
    provider: 'mock-email',
    category: 'email',
    dedupeKey: null,
    bodyText: null,
    participants: toJson([]),
    itemTimestamp: now,
    dueAt: null,
    startsAt: null,
    endsAt: null,
    url: null,
    threadExternalId: null,
    projectIds: toJson([]),
    peopleIds: toJson([]),
    labels: toJson([]),
    rawMetadata: toJson({}),
    provenance: toJson({}),
    isRead: 0,
    contentHash: null,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insertInto('sourceItems')
    .values([
      {
        ...baseItem,
        id: contractItemId,
        externalId: 'ext-contract',
        title: 'Contract renewal: legal review needed',
        snippet: 'Please review the contract redlines before Friday.',
        sender: toJson({ name: 'Jin Park', email: 'jin@example.com' }),
      },
      {
        ...baseItem,
        id: budgetItemId,
        externalId: 'ext-budget',
        title: 'Q3 budget approval',
        snippet: 'The Q3 budget needs your sign-off.',
        sender: toJson({ name: 'Maya Chen', email: 'maya@example.com' }),
      },
    ])
    .execute();

  contractTaskId = newId('tsk');
  budgetTaskId = newId('tsk');
  const baseTask = {
    workspaceId,
    description: null,
    status: 'open',
    dueAt: null,
    deferredUntil: null,
    projectId: null,
    peopleIds: toJson([]),
    origin: 'scoring',
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insertInto('taskCandidates')
    .values([
      {
        ...baseTask,
        id: contractTaskId,
        sourceItemId: contractItemId,
        title: 'Contract renewal: legal review needed',
        importanceScore: 85,
        urgencyScore: 90,
        effortScore: 40,
        overallScore: 92,
        priorityLevel: 'critical',
        urgencyLevel: 'critical',
        effortLevel: 'medium',
        planningCategory: 'do_now',
        signals: toJson([{ key: 'sender_vip', label: 'VIP sender', weight: 20 }]),
        explanation: 'Jin is a VIP and the deadline is Friday',
        recommendedAction: 'Review the redlines and reply to Jin',
      },
      {
        ...baseTask,
        id: budgetTaskId,
        sourceItemId: budgetItemId,
        title: 'Q3 budget approval',
        importanceScore: 60,
        urgencyScore: 55,
        effortScore: 30,
        overallScore: 70,
        priorityLevel: 'high',
        urgencyLevel: 'medium',
        effortLevel: 'low',
        planningCategory: 'follow_up',
        signals: toJson([{ key: 'awaiting_reply', label: 'Awaiting your reply', weight: 10 }]),
        explanation: 'Maya is waiting on your sign-off',
        recommendedAction: 'Approve or push back on the Q3 budget',
      },
    ])
    .execute();
}

async function sendUserMessage(
  content: string,
): Promise<{ events: AssistantStreamEvent[]; messageId: string }> {
  await db
    .insertInto('messages')
    .values({
      id: newId('msg'),
      conversationId,
      workspaceId,
      role: 'user',
      content,
      citations: toJson([]),
      suggestedActions: toJson([]),
      status: 'complete',
      modelUsed: null,
      llmCallId: null,
      error: null,
      createdAt: nowIso(),
    })
    .execute();
  const events: AssistantStreamEvent[] = [];
  const message = await assistant.respond({
    workspaceId,
    userId,
    conversationId,
    send: (event) => events.push(event),
  });
  return { events, messageId: message.id };
}

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedWorkspace(db);
  workspaceId = seeded.workspaceId;
  userId = seeded.userId;
  await seedData();

  conversationId = newId('cnv');
  const now = nowIso();
  await db
    .insertInto('conversations')
    .values({
      id: conversationId,
      workspaceId,
      userId,
      title: 'New conversation',
      pinned: 0,
      archived: 0,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  const audit = createAuditService({ db });
  const settings = createSettingsService({ db });
  assistant = createAssistantService({
    db,
    llm: makeLlmStub(),
    retrieval: makeRetrievalStub(),
    memory: makeMemoryStub(),
    actions: makeActionsStub(),
    settings,
    audit,
  });
});

describe('assistant demo path', () => {
  it('streams a deterministic answer from real data with citations and actions', async () => {
    const { events } = await sendUserMessage('What needs my attention today?');

    // Deltas are non-empty and concatenate to the persisted content.
    const deltas = events.filter((e): e is { type: 'delta'; text: string } => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    const streamedText = deltas.map((d) => d.text).join('');
    expect(streamedText.length).toBeGreaterThan(0);

    const persisted = await db
      .selectFrom('messages')
      .selectAll()
      .where('conversationId', '=', conversationId)
      .where('role', '=', 'assistant')
      .executeTakeFirstOrThrow();
    expect(persisted.status).toBe('complete');
    expect(persisted.content).toBe(streamedText);
    expect(persisted.content).toContain('Contract renewal: legal review needed');
    expect(persisted.content).toContain('Demo mode');
    expect(persisted.modelUsed).toBe('mock-model');

    // Citations reference real source item ids.
    const citationsEvent = events.find(
      (e): e is Extract<AssistantStreamEvent, { type: 'citations' }> => e.type === 'citations',
    );
    expect(citationsEvent).toBeDefined();
    expect(citationsEvent?.citations.length).toBeGreaterThan(0);
    expect(
      citationsEvent?.citations.some(
        (c) => c.sourceType === 'source_item' && c.refId === contractItemId,
      ),
    ).toBe(true);

    // Suggested actions include mark_done for a seeded task.
    const actionsEvent = events.find(
      (e): e is Extract<AssistantStreamEvent, { type: 'actions' }> => e.type === 'actions',
    );
    expect(actionsEvent).toBeDefined();
    const markDone = actionsEvent?.actions.find((a) => a.type === 'mark_done');
    expect(markDone).toBeDefined();
    expect([contractTaskId, budgetTaskId]).toContain(markDone?.payload['taskCandidateId']);

    // Final message event matches the persisted row.
    const messageEvent = events.find(
      (e): e is Extract<AssistantStreamEvent, { type: 'message' }> => e.type === 'message',
    );
    expect(messageEvent?.message.id).toBe(persisted.id);
    expect(messageEvent?.message.status).toBe('complete');

    // Conversation auto-titled from the first user message + lastMessageAt set.
    const conversation = await db
      .selectFrom('conversations')
      .selectAll()
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow();
    expect(conversation.title).toBe('What needs my attention today?');
    expect(conversation.lastMessageAt).not.toBeNull();
  });

  it('routes a draft request through actions.propose and includes the draft in the reply', async () => {
    const { events } = await sendUserMessage('Draft a reply to Jin about the contract');

    expect(proposeCalls).toHaveLength(1);
    const call = proposeCalls[0];
    expect(call?.capability).toBe('draft.create');
    expect(call?.params['to']).toBe('Jin');
    expect(String(call?.params['subject'])).toContain('contract');
    expect(String(call?.params['body'])).toContain('Hi Jin,');
    expect(call?.preview.summary).toContain('Draft a reply to Jin');
    expect(call?.conversationId).toBe(conversationId);

    // Auto-approved: no approval_created event, draft woven into the reply.
    expect(events.some((e) => e.type === 'approval_created')).toBe(false);
    const persisted = await db
      .selectFrom('messages')
      .selectAll()
      .where('conversationId', '=', conversationId)
      .where('role', '=', 'assistant')
      .executeTakeFirstOrThrow();
    expect(persisted.content).toContain("Here's the draft I put together");
    expect(persisted.content).toContain('> Hi Jin,');
    expect(persisted.status).toBe('complete');
  });

  it('captures durable preferences into memory and acknowledges it', async () => {
    const query = 'Remember that I prefer short answers';
    await sendUserMessage(query);

    expect(memoryCreate).toHaveBeenCalledTimes(1);
    expect(memoryCreate).toHaveBeenCalledWith(workspaceId, userId, {
      kind: 'preference',
      content: query,
      origin: 'inferred',
      confidence: 0.6,
      provenance: { conversationId },
    });

    const persisted = await db
      .selectFrom('messages')
      .selectAll()
      .where('conversationId', '=', conversationId)
      .where('role', '=', 'assistant')
      .executeTakeFirstOrThrow();
    expect(persisted.content).toContain("Noted — I'll remember that.");
  });
});

describe('graceful degradation when personalization stores are unavailable', () => {
  it('still answers when memory and retrieval lookups fail', async () => {
    const audit = createAuditService({ db });
    const settings = createSettingsService({ db });
    const failingMemory: MemoryService = {
      ...makeMemoryStub(),
      relevant: async () => {
        throw new Error('memory store unavailable');
      },
    };
    const failingRetrieval: RetrievalService = {
      search: async () => {
        throw new Error('retrieval backend down');
      },
    };
    const degraded = createAssistantService({
      db,
      llm: makeLlmStub(),
      retrieval: failingRetrieval,
      memory: failingMemory,
      actions: makeActionsStub(),
      settings,
      audit,
    });

    await db
      .insertInto('messages')
      .values({
        id: newId('msg'),
        conversationId,
        workspaceId,
        role: 'user',
        content: 'What needs my attention today?',
        citations: toJson([]),
        suggestedActions: toJson([]),
        status: 'complete',
        modelUsed: null,
        llmCallId: null,
        error: null,
        createdAt: nowIso(),
      })
      .execute();

    const events: AssistantStreamEvent[] = [];
    const message = await degraded.respond({
      workspaceId,
      userId,
      conversationId,
      send: (event) => events.push(event),
    });

    // Jarvis answered from the remaining context instead of crashing.
    expect(message.status).toBe('complete');
    expect(message.content.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
