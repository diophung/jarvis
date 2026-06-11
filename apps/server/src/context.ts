/**
 * AppContext: the service container contract. Every service interface is
 * defined here so route modules and services can be built independently and
 * wired together in services/index.ts + app.ts.
 */
import type {
  AgentAction,
  ApprovalRequest,
  AuditLog,
  Citation,
  ConnectorRun,
  Digest,
  DigestItem,
  FeedbackKind,
  LlmProviderKind,
  LlmTask,
  MemoryEntry,
  MemoryKind,
  Message,
  PolicyDecision,
  RiskLevel,
  ScoringContext,
  SourceCategory,
  SuggestedAction,
  UploadedFile,
} from '@donna/core';
import type { ConnectorRegistry, SecretResolver } from '@donna/connectors';
import type { Db } from '@donna/db';
import type { LlmClient, LlmHealth } from '@donna/llm';
import type { AppConfig } from './config.js';

// ---------- Audit ----------
export interface AuditEntryInput {
  workspaceId: string;
  userId?: string | null;
  eventType: AuditLog['eventType'];
  actor: AuditLog['actor'];
  capability?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  /** Will be redacted (secret-looking keys stripped, long strings truncated). */
  metadata?: Record<string, unknown>;
}

export interface AuditService {
  log(entry: AuditEntryInput): Promise<void>;
  list(
    workspaceId: string,
    opts?: { limit?: number; before?: string; eventType?: string; actor?: string },
  ): Promise<AuditLog[]>;
}

// ---------- Settings ----------
export interface SettingsService {
  get<T>(workspaceId: string, key: string, fallback: T): Promise<T>;
  set(workspaceId: string, key: string, value: unknown): Promise<void>;
  getAll(workspaceId: string): Promise<Record<string, unknown>>;
}

/** Well-known settings keys. */
export const SETTING_KEYS = {
  digestSchedule: 'digest.schedule', // { cron: string; enabled: boolean; timezone?: string }
  digestLastScheduledAt: 'digest.lastScheduledAt', // ISO string
  memoryEnabled: 'memory.enabled', // boolean (default true)
  syncIntervalMinutes: 'sync.intervalMinutes', // number (default 15)
  responseStyle: 'assistant.responseStyle', // 'concise' | 'detailed'
} as const;

// ---------- Secrets ----------
export interface SecretsService {
  /** Resolve an env-var reference. */
  env(ref: string): string | undefined;
  /** Decrypt a UI-entered secret stored encrypted in the DB. */
  decrypt(encrypted: string): string | null;
  encrypt(plaintext: string): string;
  /** SecretResolver handed to connectors (env-backed). */
  connectorResolver(): SecretResolver;
}

// ---------- LLM routing ----------
export interface RoutedLlm {
  client: LlmClient;
  model: string;
  params: { temperature?: number; maxTokens?: number };
  providerConfigId: string | null;
  providerName: string;
  kind: LlmProviderKind;
  isLocal: boolean;
  /** True when falling back to the mock provider (demo mode). */
  isMock: boolean;
}

export interface LlmTaskStatus {
  providerConfigId: string | null;
  providerName: string;
  model: string;
  kind: LlmProviderKind;
  isLocal: boolean;
}

export interface LlmRouterService {
  /**
   * Resolve the client for a task from DB routes + provider configs. Falls
   * back to: task route -> any enabled provider -> mock (demo mode).
   * purposeRef is attached to llm_call_logs rows.
   */
  clientForTask(
    workspaceId: string,
    task: LlmTask,
    purposeRef?: { conversationId?: string; digestId?: string; sourceItemId?: string },
    userId?: string | null,
  ): Promise<RoutedLlm>;
  /** Embedding client, or null when no configured provider supports embeddings. (Mock is NOT used implicitly for embeddings unless it is the explicitly routed provider.) */
  embeddingClient(workspaceId: string): Promise<RoutedLlm | null>;
  healthCheck(workspaceId: string, providerConfigId: string): Promise<LlmHealth>;
  listModels(workspaceId: string, providerConfigId: string): Promise<string[]>;
  /** Demo-mode + per-task routing summary for the UI banner / settings. */
  status(workspaceId: string): Promise<{
    demoMode: boolean;
    tasks: Record<LlmTask, LlmTaskStatus | null>;
  }>;
}

// ---------- Ingestion ----------
export interface IngestionService {
  /** Run a connector sync for one account: fetch pages, normalize, upsert, index, record ConnectorRun + audit. */
  syncAccount(
    workspaceId: string,
    accountId: string,
    opts: { mode: 'full' | 'incremental'; triggeredBy: 'manual' | 'scheduled' | 'connect' },
  ): Promise<ConnectorRun>;
  /** Sync all connected accounts that are due (used by the worker). Returns number of accounts synced. */
  syncDueAccounts(opts: { triggeredBy: 'scheduled' }): Promise<number>;
}

// ---------- Indexing & retrieval ----------
export interface IndexingService {
  /** Chunk text, store retrieval chunks, embed when an embedding provider is configured. */
  indexText(
    workspaceId: string,
    sourceType: 'source_item' | 'uploaded_file' | 'message' | 'memory' | 'digest',
    refId: string,
    text: string,
    metadata: { title?: string; sourceLabel?: string; category?: SourceCategory; url?: string },
  ): Promise<{ chunks: number; embedded: boolean }>;
  removeIndex(sourceType: string, refId: string): Promise<void>;
}

export interface SearchResult {
  chunkId: string;
  sourceType: 'source_item' | 'uploaded_file' | 'message' | 'memory' | 'digest';
  refId: string;
  title: string;
  snippet: string;
  score: number;
  matchType: 'keyword' | 'semantic' | 'both';
  sourceLabel?: string;
  category?: SourceCategory;
  url?: string;
}

export interface RetrievalService {
  search(
    workspaceId: string,
    query: string,
    opts?: {
      limit?: number;
      sourceTypes?: SearchResult['sourceType'][];
      categories?: SourceCategory[];
    },
  ): Promise<{ results: SearchResult[]; mode: 'keyword' | 'semantic+keyword' }>;
}

// ---------- Scoring ----------
export interface ScoringService {
  buildContext(workspaceId: string, now: string): Promise<ScoringContext>;
  /**
   * Score recent source items, upsert TaskCandidates (stable per sourceItemId,
   * origin 'scoring'; never overwrite user-modified status). Optionally
   * refine with the classification LLM when configured (never required).
   */
  rescoreWorkspace(workspaceId: string, opts?: { sinceDays?: number }): Promise<{ scored: number }>;
}

// ---------- Digest ----------
export interface DigestWithItems extends Digest {
  items: DigestItem[];
}

export interface DigestService {
  generate(
    workspaceId: string,
    userId: string,
    opts: { kind: 'daily' | 'manual' | 'scheduled'; supersedesDigestId?: string },
  ): Promise<DigestWithItems>;
  list(workspaceId: string, opts?: { limit?: number }): Promise<Digest[]>;
  get(workspaceId: string, digestId: string): Promise<DigestWithItems | null>;
}

// ---------- Agent actions & approvals ----------
export interface ProposeActionInput {
  workspaceId: string;
  userId: string;
  capability: string;
  actionType: string;
  params: Record<string, unknown>;
  target: { provider?: string; accountId?: string; refId?: string; description?: string };
  reason: string;
  preview: { summary: string; body?: string; fields?: Record<string, string> };
  conversationId?: string | null;
  messageId?: string | null;
}

export interface ProposeActionResult {
  action: AgentAction;
  decision: PolicyDecision;
  /** Present when the action requires approval. */
  approval: ApprovalRequest | null;
}

export interface ActionsService {
  /** Policy-gate a proposed action: deny, queue for approval, or auto-execute. Always audited. */
  propose(input: ProposeActionInput): Promise<ProposeActionResult>;
  /** Execute an approved/auto-approved action (connector write or local effect). */
  execute(actionId: string): Promise<AgentAction>;
  decideApproval(
    workspaceId: string,
    approvalId: string,
    userId: string,
    decision: 'approve' | 'deny',
    opts?: { note?: string; alwaysAllow?: boolean },
  ): Promise<ApprovalRequest>;
  listApprovals(workspaceId: string, status?: string): Promise<ApprovalRequest[]>;
  /** Risk level shown in previews for a capability. */
  riskFor(capability: string): RiskLevel;
}

// ---------- Memory ----------
export interface MemoryService {
  isEnabled(workspaceId: string): Promise<boolean>;
  list(workspaceId: string, opts?: { includeDisabled?: boolean }): Promise<MemoryEntry[]>;
  create(
    workspaceId: string,
    userId: string,
    input: {
      kind: MemoryKind;
      content: string;
      origin: 'explicit' | 'inferred' | 'feedback';
      confidence?: number;
      provenance?: Record<string, unknown>;
    },
  ): Promise<MemoryEntry>;
  update(
    workspaceId: string,
    id: string,
    patch: Partial<Pick<MemoryEntry, 'content' | 'kind' | 'enabled'>>,
  ): Promise<MemoryEntry>;
  remove(workspaceId: string, id: string): Promise<void>;
  exportAll(workspaceId: string): Promise<MemoryEntry[]>;
  /** Memories relevant to a query (keyword match; recency + confidence ranked). Empty when memory disabled. */
  relevant(workspaceId: string, query: string, limit?: number): Promise<MemoryEntry[]>;
}

// ---------- Feedback ----------
export interface FeedbackService {
  record(
    workspaceId: string,
    userId: string,
    input: {
      kind: FeedbackKind;
      sourceItemId?: string;
      taskCandidateId?: string;
      digestItemId?: string;
      note?: string;
    },
  ): Promise<void>;
}

// ---------- Assistant ----------
export type AssistantStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'actions'; actions: SuggestedAction[] }
  | { type: 'approval_created'; approvalId: string }
  | { type: 'message'; message: Message }
  | { type: 'error'; error: string };

export interface AssistantService {
  /**
   * Generate the assistant reply for the latest user message in a
   * conversation. Streams events through `send` and resolves with the
   * persisted assistant Message.
   */
  respond(opts: {
    workspaceId: string;
    userId: string;
    conversationId: string;
    send: (event: AssistantStreamEvent) => void;
    abortSignal?: AbortSignal;
  }): Promise<Message>;
}

// ---------- Storage & uploads ----------
export interface StorageService {
  save(workspaceId: string, filename: string, data: Buffer): Promise<{
    storagePath: string;
    sizeBytes: number;
    sha256: string;
  }>;
  read(storagePath: string): Promise<Buffer>;
  remove(storagePath: string): Promise<void>;
}

export interface UploadsService {
  handleUpload(
    workspaceId: string,
    userId: string,
    file: { filename: string; mimeType: string | null; data: Buffer },
  ): Promise<UploadedFile>;
  list(workspaceId: string): Promise<UploadedFile[]>;
  get(workspaceId: string, id: string): Promise<UploadedFile | null>;
  /** Extracted text content (for preview / citation opening). */
  getText(workspaceId: string, id: string): Promise<string | null>;
  remove(workspaceId: string, id: string): Promise<void>;
}

/**
 * Per-source Google OAuth grants: encrypted token storage, refresh,
 * revocation. The connector layer consumes tokens only through
 * tokenSourceFor(); raw tokens never cross the API surface.
 */
export interface TokensService {
  /** Valid access token for a user's source grant; refreshes when expired. */
  getGoogleAccessTokenForUser(userId: string, sourceType: string): Promise<string>;
  /** Proactive refresh when the cached access token is near expiry. */
  refreshGoogleTokenIfNeeded(userId: string, sourceType: string): Promise<void>;
  /** OAuthTokenSource for a connected account (ConnectorContext.oauth). */
  tokenSourceFor(sourceAccountId: string): { getAccessToken(): Promise<string> };
  /** True when the account's credentials come from a stored OAuth grant. */
  isOauthAccount(authRef: string | null): boolean;
  /** Revoke at the provider (best effort), wipe stored tokens, mark revoked. */
  disconnectSource(sourceAccountId: string): Promise<void>;
}

// ---------- Container ----------
export interface Services {
  audit: AuditService;
  settings: SettingsService;
  secrets: SecretsService;
  tokens: TokensService;
  llm: LlmRouterService;
  ingestion: IngestionService;
  indexing: IndexingService;
  retrieval: RetrievalService;
  scoring: ScoringService;
  digest: DigestService;
  actions: ActionsService;
  memory: MemoryService;
  feedback: FeedbackService;
  assistant: AssistantService;
  storage: StorageService;
  uploads: UploadsService;
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  connectors: ConnectorRegistry;
  services: Services;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    workspaceId: string;
    /** Id of the DB session backing this request ('' for unauthenticated). */
    sessionId: string;
  }
}
