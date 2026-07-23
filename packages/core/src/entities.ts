/**
 * Domain entities. These mirror DB rows (camelCase here; the DB layer maps to
 * snake_case via Kysely's CamelCasePlugin). JSON-ish fields are typed as their
 * parsed shapes here; the DB layer stores them as JSON text.
 *
 * Conventions (portable across SQLite and Postgres):
 *  - ids: prefixed text ids (see ids.ts)
 *  - timestamps: ISO-8601 strings (UTC)
 *  - booleans: 0 | 1 integers at the DB layer, exposed as numbers here
 */
import type {
  ActorType,
  AgentActionStatus,
  ApprovalStatus,
  AuditEventType,
  ConnectorCapability,
  ConnectorRunStatus,
  DigestKind,
  DigestSection,
  DigestStatus,
  FeedbackKind,
  GoogleSourceType,
  Level,
  LlmProviderKind,
  LlmTask,
  MemoryKind,
  MessageRole,
  OauthLoginProvider,
  OauthTokenStatus,
  PersonImportance,
  PlanningCategory,
  PolicyEffect,
  RiskLevel,
  SourceAccountStatus,
  SourceCategory,
  TaskCandidateStatus,
} from './enums.js';

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  role: 'owner' | 'member';
  /** True once the email is verified (OAuth providers with verified emails set this). */
  emailVerified: boolean;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A linked OAuth login identity (Google / Facebook / Apple). One user may have several. */
export interface AuthAccount {
  id: string;
  userId: string;
  provider: OauthLoginProvider;
  /** The provider's stable subject/user id ('sub' claim or graph id). */
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A server-side login session. The cookie holds an opaque token; only its hash is stored. */
export interface SessionRecord {
  id: string;
  userId: string;
  workspaceId: string;
  /** sha256(base64url token) — the raw token never touches the database. */
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
}

/**
 * Per-source OAuth token grant (data-source authorization, distinct from login).
 * Access/refresh tokens are AES-256-GCM encrypted at rest and never leave the server.
 */
export interface OauthToken {
  id: string;
  workspaceId: string;
  userId: string;
  provider: 'google';
  sourceType: GoogleSourceType;
  /** The connected sourceAccounts row this grant backs (set after account creation). */
  sourceAccountId: string | null;
  providerAccountId: string | null;
  providerEmail: string | null;
  grantedScopes: string[];
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  accessTokenExpiresAt: string | null;
  status: OauthTokenStatus;
  lastRefreshedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** A lightweight reference to a person as seen in a source item. */
export interface PersonRef {
  name?: string;
  email?: string;
  handle?: string;
  personId?: string;
}

export interface SourceAccount {
  id: string;
  workspaceId: string;
  userId: string;
  provider: string;
  category: SourceCategory;
  displayName: string;
  status: SourceAccountStatus;
  /** Reference to where credentials live (env var name / secret ref). Never the secret itself. */
  authRef: string | null;
  scopes: string[];
  capabilities: ConnectorCapability[];
  settings: Record<string, unknown>;
  lastSyncAt: string | null;
  syncCursor: string | null;
  /** Last connection-level error (e.g. token refresh failure), surfaced in the UI. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceItem {
  id: string;
  workspaceId: string;
  accountId: string;
  provider: string;
  category: SourceCategory;
  externalId: string;
  dedupeKey: string | null;
  title: string;
  bodyText: string | null;
  snippet: string | null;
  sender: PersonRef | null;
  participants: PersonRef[];
  /** Primary timestamp of the item (sent / modified / starts for events). */
  itemTimestamp: string;
  dueAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  url: string | null;
  threadExternalId: string | null;
  projectIds: string[];
  peopleIds: string[];
  labels: string[];
  rawMetadata: Record<string, unknown>;
  /** Where this came from: connector run, upload, etc. */
  provenance: { connectorRunId?: string; uploadedFileId?: string; note?: string };
  isRead: number;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceAttachment {
  id: string;
  itemId: string;
  workspaceId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  externalRef: string | null;
  storagePath: string | null;
  textExtracted: number;
  createdAt: string;
}

export interface Person {
  id: string;
  workspaceId: string;
  displayName: string;
  emails: string[];
  handles: string[];
  organizationId: string | null;
  title: string | null;
  importance: PersonImportance;
  isSelf: number;
  interactionCount: number;
  lastInteractionAt: string | null;
  notes: string | null;
  origin: 'user' | 'observed' | 'connector';
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  workspaceId: string;
  name: string;
  domains: string[];
  notes: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'done' | 'archived';
  priority: 'high' | 'normal' | 'low';
  keywords: string[];
  stakeholderPeopleIds: string[];
  dueAt: string | null;
  origin: 'user' | 'observed';
  createdAt: string;
  updatedAt: string;
}

export interface ScoreSignal {
  key: string;
  label: string;
  /** Contribution in score points (positive or negative). */
  weight: number;
  detail?: string;
}

export interface TaskCandidate {
  id: string;
  workspaceId: string;
  sourceItemId: string | null;
  title: string;
  description: string | null;
  status: TaskCandidateStatus;
  dueAt: string | null;
  deferredUntil: string | null;
  importanceScore: number;
  urgencyScore: number;
  effortScore: number;
  overallScore: number;
  priorityLevel: Level;
  urgencyLevel: Level;
  effortLevel: Level;
  planningCategory: PlanningCategory;
  signals: ScoreSignal[];
  explanation: string | null;
  recommendedAction: string | null;
  projectId: string | null;
  peopleIds: string[];
  origin: 'scoring' | 'user' | 'agent';
  createdAt: string;
  updatedAt: string;
}

export interface Digest {
  id: string;
  workspaceId: string;
  userId: string;
  kind: DigestKind;
  status: DigestStatus;
  generatedAt: string | null;
  periodStart: string;
  periodEnd: string;
  /** Executive narrative summary (markdown). */
  summaryMarkdown: string | null;
  /** Suggested plan for the day (markdown). */
  planMarkdown: string | null;
  modelUsed: string | null;
  stats: Record<string, number>;
  supersedesDigestId: string | null;
  error: string | null;
  createdAt: string;
}

export interface DigestItem {
  id: string;
  digestId: string;
  workspaceId: string;
  sourceItemId: string | null;
  taskCandidateId: string | null;
  title: string;
  sourceLabel: string;
  sourceCategory: SourceCategory | null;
  itemTimestamp: string | null;
  section: DigestSection;
  planningCategory: PlanningCategory;
  priorityLevel: Level;
  urgencyLevel: Level;
  effortLevel: Level;
  recommendedAction: string | null;
  explanation: string;
  signals: ScoreSignal[];
  rank: number;
  createdAt: string;
}

export interface UserPreference {
  id: string;
  workspaceId: string;
  userId: string;
  key: string;
  value: unknown;
  /** explicit = user said so; derived = inferred from behavior. Kept separate on purpose. */
  kind: 'explicit' | 'derived';
  origin: 'user' | 'feedback' | 'onboarding' | 'agent';
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntry {
  id: string;
  workspaceId: string;
  userId: string;
  kind: MemoryKind;
  content: string;
  origin: 'explicit' | 'inferred' | 'feedback';
  confidence: number;
  enabled: number;
  relatedPeopleIds: string[];
  relatedProjectIds: string[];
  provenance: { conversationId?: string; sourceItemId?: string; note?: string };
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionPolicy {
  id: string;
  workspaceId: string;
  userId: string;
  /** Agent capability pattern, e.g. `email.send` or `calendar.*`. */
  capability: string;
  effect: PolicyEffect;
  /** Optional constraints, e.g. { provider: 'gmail', accountId: '...' }. */
  scope: Record<string, unknown>;
  description: string | null;
  createdBy: 'default' | 'user' | 'approval_flow';
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  userId: string;
  agentActionId: string;
  capability: string;
  actionType: string;
  targetProvider: string | null;
  targetAccountId: string | null;
  targetRef: Record<string, unknown>;
  riskLevel: RiskLevel;
  reason: string;
  /** Human-readable preview of what would happen, e.g. draft email body. */
  preview: { summary: string; body?: string; fields?: Record<string, string> };
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  conversationId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  workspaceId: string;
  userId: string | null;
  eventType: AuditEventType;
  actor: ActorType;
  capability: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  /** Redacted structured details. Never put secrets or full sensitive content here. */
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  userId: string;
  title: string;
  pinned: number;
  archived: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Citation {
  /** What kind of thing is being cited. */
  sourceType: 'source_item' | 'uploaded_file' | 'memory' | 'digest' | 'task_candidate';
  refId: string;
  title: string;
  sourceLabel?: string;
  snippet?: string;
  url?: string;
}

/** A contextual action chip attached to an assistant message or digest item. */
export interface SuggestedAction {
  type:
    | 'mark_done'
    | 'defer'
    | 'create_draft'
    | 'create_task'
    | 'schedule_follow_up'
    | 'open_source'
    | 'ask_why'
    | 'change_priority'
    | 'ignore_similar'
    | 'add_preference';
  label: string;
  /** Target + parameters needed to perform the action. */
  payload: Record<string, unknown>;
}

export interface Message {
  id: string;
  conversationId: string;
  workspaceId: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  suggestedActions: SuggestedAction[];
  status: 'complete' | 'streaming' | 'error';
  modelUsed: string | null;
  llmCallId: string | null;
  error: string | null;
  createdAt: string;
}

export interface UploadedFile {
  id: string;
  workspaceId: string;
  userId: string;
  accountId: string | null;
  sourceItemId: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number;
  storagePath: string;
  textExtracted: number;
  extractionError: string | null;
  status: 'processing' | 'ready' | 'error';
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRun {
  id: string;
  workspaceId: string;
  accountId: string;
  mode: 'incremental' | 'full';
  status: ConnectorRunStatus;
  startedAt: string;
  completedAt: string | null;
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  errorCount: number;
  errors: string[];
  cursorBefore: string | null;
  cursorAfter: string | null;
  log: string | null;
  triggeredBy: 'manual' | 'scheduled' | 'connect';
  createdAt: string;
}

export interface LlmProviderConfig {
  id: string;
  workspaceId: string;
  name: string;
  kind: LlmProviderKind;
  baseUrl: string | null;
  model: string;
  /** Name of env var holding the key (preferred), if any. */
  apiKeyEnv: string | null;
  /** Key entered via UI, encrypted at rest with JARVIS_SECRET. Masked in API responses. */
  apiKeyEncrypted: string | null;
  temperature: number | null;
  maxTokens: number | null;
  timeoutMs: number | null;
  extraHeaders: Record<string, string>;
  enabled: number;
  /** Whether inference happens locally (shown prominently in the UI). */
  isLocal: number;
  supportsEmbeddings: number;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmTaskRoute {
  id: string;
  workspaceId: string;
  task: LlmTask;
  providerConfigId: string | null;
  modelOverride: string | null;
  params: { temperature?: number; maxTokens?: number };
  createdAt: string;
  updatedAt: string;
}

export interface LlmCallLog {
  id: string;
  workspaceId: string;
  userId: string | null;
  providerConfigId: string | null;
  providerKind: LlmProviderKind;
  model: string;
  task: LlmTask;
  status: 'success' | 'error' | 'timeout';
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  /** Redacted request summary (counts/sizes only, never content). */
  requestSummary: Record<string, unknown>;
  purposeRef: { conversationId?: string; digestId?: string; sourceItemId?: string };
  createdAt: string;
}

export interface RetrievalChunk {
  id: string;
  workspaceId: string;
  sourceType: 'source_item' | 'uploaded_file' | 'message' | 'memory' | 'digest';
  refId: string;
  chunkIndex: number;
  text: string;
  metadata: { title?: string; sourceLabel?: string; category?: SourceCategory; url?: string };
  createdAt: string;
}

export interface EmbeddingRecord {
  id: string;
  workspaceId: string;
  chunkId: string;
  providerConfigId: string | null;
  model: string;
  dims: number;
  /** JSON array of floats at rest. */
  vector: number[];
  createdAt: string;
}

export interface AgentAction {
  id: string;
  workspaceId: string;
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  capability: string;
  actionType: string;
  params: Record<string, unknown>;
  target: { provider?: string; accountId?: string; refId?: string; description?: string };
  status: AgentActionStatus;
  riskLevel: RiskLevel;
  policyId: string | null;
  approvalRequestId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  executedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemFeedback {
  id: string;
  workspaceId: string;
  userId: string;
  sourceItemId: string | null;
  taskCandidateId: string | null;
  digestItemId: string | null;
  kind: FeedbackKind;
  note: string | null;
  createdAt: string;
}

export interface AppSetting {
  id: string;
  workspaceId: string;
  key: string;
  value: unknown;
  updatedAt: string;
}
