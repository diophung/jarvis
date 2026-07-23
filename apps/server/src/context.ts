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
  ContradictionReportEntry,
  Digest,
  DigestItem,
  DraftEditInput,
  ExplicitStatementInput,
  FeedbackKind,
  FeedbackObservation,
  LearnedPreference,
  LearningScope,
  LearningSignal,
  LearningSignalInput,
  LlmProviderKind,
  LlmTask,
  MemoryEntry,
  MemoryKind,
  Message,
  PersonalizationRequest,
  PersonalizationResult,
  PolicyDecision,
  PreferenceCategory,
  RiskLevel,
  ScoringContext,
  SourceCategory,
  SuggestedAction,
  UploadedFile,
} from '@jarvis/core';
import type { ConnectorRegistry, SecretResolver } from '@jarvis/connectors';
import type { Db, DbMetrics } from '@jarvis/db';
import type { DataDeletionRequestsTable } from '@jarvis/db';
import type { LlmClient, LlmHealth } from '@jarvis/llm';
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
  learningEnabled: 'learning.enabled', // boolean (default true)
  learningLastExtractedAt: 'learning.lastExtractedAt', // ISO string watermark
  learningLastRunAt: 'learning.lastRunAt', // ISO string (worker cadence)
  learningLastDecayAt: 'learning.lastDecayAt', // ISO string (daily decay)
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

// ---------- Cache (hot reads; disposable, never the source of truth) ----------
export interface CacheStats {
  backend: 'memory' | 'redis';
  hits: number;
  misses: number;
  errors: number;
  breakerState?: string;
}

export interface CacheService {
  /** undefined on miss OR on any backend failure (cache fails open). */
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Read-through helper: get, else load + set. Loader errors propagate; cache errors do not. */
  withCache<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T>;
  stats(): CacheStats;
  close(): Promise<void>;
}

// ---------- Idempotency (replay protection for unsafe writes) ----------
export type IdempotencyBegin =
  | { kind: 'replay'; responseStatus: number; responseBody: string | null }
  | { kind: 'key_reuse_conflict' } // same key, different request body
  | { kind: 'in_flight_conflict' } // concurrent duplicate still executing
  | {
      kind: 'proceed';
      /** Persist the response so retries replay it. */
      complete(responseStatus: number, responseBody: unknown): Promise<void>;
      /** Release the key after a handler failure so the client may retry. */
      abandon(): Promise<void>;
    };

export interface IdempotencyService {
  begin(
    workspaceId: string,
    userId: string,
    endpoint: string,
    key: string,
    requestHash: string,
    opts?: { ttlHours?: number },
  ): Promise<IdempotencyBegin>;
  /** Worker GC: delete expired records, returns count. */
  cleanupExpired(): Promise<number>;
}

// ---------- Vector store (semantic memory retrieval backend) ----------
export interface VectorUpsertRecord {
  chunkId: string;
  providerConfigId: string | null;
  model: string;
  vector: number[];
}

export interface VectorSearchHit {
  chunkId: string;
  cosine: number;
  sourceType: string;
  refId: string;
  text: string;
  /** JSON metadata as stored on the chunk. */
  metadata: string;
  createdAt: string;
}

export interface VectorStore {
  kind: 'sql_scan' | 'pgvector';
  upsert(workspaceId: string, records: VectorUpsertRecord[]): Promise<void>;
  search(
    workspaceId: string,
    model: string,
    queryVector: number[],
    opts?: { limit?: number; minCosine?: number; sourceTypes?: string[] },
  ): Promise<VectorSearchHit[]>;
  removeByChunkIds(chunkIds: string[]): Promise<void>;
}

// ---------- Privacy (export + deletion) ----------
export interface DeletionRequestStatus extends Omit<DataDeletionRequestsTable, 'tablesPurged'> {
  tablesPurged: Record<string, number>;
}

export interface PrivacyService {
  /** Full account data export (per-table rows, capped, with truncation flags). Audited. */
  exportAccountData(
    workspaceId: string,
    userId: string,
  ): Promise<{
    exportedAt: string;
    user: unknown;
    tables: Record<string, { rows: unknown[]; truncated: boolean }>;
  }>;
  /** Create a pending deletion job (409 when one is already in flight). Audited. */
  requestDeletion(workspaceId: string, userId: string): Promise<DeletionRequestStatus>;
  getDeletionStatus(workspaceId: string): Promise<DeletionRequestStatus | null>;
  /** Worker: claim + execute pending deletion jobs. */
  processPending(): Promise<{ processed: number }>;
}

// ---------- Self-learning ----------
export interface UserCorrection {
  action: 'confirm' | 'mark_wrong' | 'pin' | 'unpin' | 'edit' | 'delete';
  /** Replacement statement for 'edit'. */
  statement?: string;
  /** Optional user note recorded on the preference. */
  note?: string;
}

export interface LearningService {
  isEnabled(workspaceId: string): Promise<boolean>;
  /** Privacy-guarded signal intake (sensitive content is dropped, never stored). Returns count stored. */
  recordSignals(
    workspaceId: string,
    userId: string,
    signals: LearningSignalInput[],
  ): Promise<number>;
  /** Extract signals from source items + approval decisions since the watermark. */
  extractFromSources(workspaceId: string): Promise<{ signals: number }>;
  /** Aggregate pending signals into learned preferences. */
  runInference(workspaceId: string): Promise<{ created: number; updated: number }>;
  /** extract + infer + merge in one audited pass (worker / manual trigger). */
  learnNow(workspaceId: string): Promise<{ signals: number; created: number; updated: number }>;
  /** Apply confidence decay; retire unreinforced preferences below threshold. */
  decayConfidence(workspaceId: string): Promise<{ decayed: number; retired: number }>;
  list(
    workspaceId: string,
    userId: string,
    opts?: { includeInactive?: boolean; category?: PreferenceCategory },
  ): Promise<LearnedPreference[]>;
  get(workspaceId: string, id: string): Promise<LearnedPreference | null>;
  /** "Why Jarvis thinks this": preference + the recent signals behind it. */
  explain(
    workspaceId: string,
    id: string,
  ): Promise<{ preference: LearnedPreference; recentSignals: LearningSignal[] }>;
  /** Actionable preferences matching a context, most specific scope last. */
  getPreferencesByContext(
    workspaceId: string,
    userId: string,
    context: LearningScope,
  ): Promise<LearnedPreference[]>;
  /** Keyword search over statements/keys (searchMemory). */
  search(workspaceId: string, userId: string, query: string): Promise<LearnedPreference[]>;
  /** User-stated preference, stored at explicit origin/confidence. */
  createExplicit(
    workspaceId: string,
    userId: string,
    input: { statement: string; category?: PreferenceCategory; scope?: LearningScope },
  ): Promise<LearnedPreference>;
  /** Confirm / pin / edit / mark wrong / delete — explicit feedback always wins. */
  applyUserCorrection(
    workspaceId: string,
    userId: string,
    preferenceId: string,
    correction: UserCorrection,
  ): Promise<LearnedPreference | null>;
  remove(workspaceId: string, id: string): Promise<void>;
  /** Merge same-key/value preferences whose scopes nest (mergeSimilarMemories). */
  mergeSimilar(workspaceId: string, userId: string): Promise<{ merged: number }>;
  detectContradictions(
    workspaceId: string,
    userId: string,
  ): Promise<ContradictionReportEntry[]>;
  /** Synchronous hook: learn from explicit item feedback. */
  learnFromFeedback(
    workspaceId: string,
    userId: string,
    observation: FeedbackObservation,
  ): Promise<void>;
  /** Synchronous hook: learn style from a user's edit of an AI draft. */
  learnFromDraftEdit(
    workspaceId: string,
    userId: string,
    input: DraftEditInput,
  ): Promise<number>;
  /** Synchronous hook: parse explicit preference commands out of user text. */
  learnFromText(
    workspaceId: string,
    userId: string,
    input: ExplicitStatementInput,
  ): Promise<number>;
}

export interface PersonalizationService {
  /**
   * Personalization config + the applied preferences with reasons for a
   * task. Live calendar density feeds the cognitive-load `userBusy` hint
   * unless the caller sets it.
   */
  forTask(
    workspaceId: string,
    userId: string,
    req: PersonalizationRequest,
  ): Promise<PersonalizationResult>;
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
  cache: CacheService;
  idempotency: IdempotencyService;
  vectors: VectorStore;
  privacy: PrivacyService;
  llm: LlmRouterService;
  ingestion: IngestionService;
  indexing: IndexingService;
  retrieval: RetrievalService;
  scoring: ScoringService;
  digest: DigestService;
  actions: ActionsService;
  memory: MemoryService;
  feedback: FeedbackService;
  learning: LearningService;
  personalization: PersonalizationService;
  assistant: AssistantService;
  storage: StorageService;
  uploads: UploadsService;
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  connectors: ConnectorRegistry;
  services: Services;
  /** Query latency/error/slow-query observability fed by createDb's log hook. */
  dbMetrics?: DbMetrics;
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    workspaceId: string;
    /** Id of the DB session backing this request ('' for unauthenticated). */
    sessionId: string;
  }
}
