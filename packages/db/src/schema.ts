/**
 * Kysely table definitions. Field names are camelCase; the CamelCasePlugin
 * maps them to snake_case columns. Conventions:
 *  - ids/timestamps: text (ISO-8601 for timestamps)
 *  - booleans: integer 0|1
 *  - JSON: text columns (string here); parse with @donna/core fromJson()
 */

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  role: string;
  emailVerified: number; // 0|1
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthAccountsTable {
  id: string;
  userId: string;
  provider: string; // 'google' | 'facebook' | 'apple'
  providerAccountId: string;
  email: string | null;
  emailVerified: number; // 0|1
  displayName: string | null;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionsTable {
  id: string;
  userId: string;
  workspaceId: string;
  tokenHash: string; // sha256 of the raw cookie token; raw token is never stored
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
}

export interface OauthTokensTable {
  id: string;
  workspaceId: string;
  userId: string;
  provider: string; // 'google'
  sourceType: string; // 'gmail' | 'google-drive' | 'google-calendar'
  sourceAccountId: string | null;
  providerAccountId: string | null;
  providerEmail: string | null;
  grantedScopes: string; // json string[]
  accessTokenEncrypted: string | null; // AES-256-GCM envelope, never plaintext
  refreshTokenEncrypted: string | null;
  accessTokenExpiresAt: string | null;
  status: string; // 'active' | 'needs_reauth' | 'revoked'
  lastRefreshedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspacesTable {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceAccountsTable {
  id: string;
  workspaceId: string;
  userId: string;
  provider: string;
  category: string;
  displayName: string;
  status: string;
  authRef: string | null;
  scopes: string; // json string[]
  capabilities: string; // json ConnectorCapability[]
  settings: string; // json object
  lastSyncAt: string | null;
  syncCursor: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceItemsTable {
  id: string;
  workspaceId: string;
  accountId: string;
  provider: string;
  category: string;
  externalId: string;
  dedupeKey: string | null;
  title: string;
  bodyText: string | null;
  snippet: string | null;
  sender: string | null; // json PersonRef
  participants: string; // json PersonRef[]
  itemTimestamp: string;
  dueAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  url: string | null;
  threadExternalId: string | null;
  projectIds: string; // json string[]
  peopleIds: string; // json string[]
  labels: string; // json string[]
  rawMetadata: string; // json object
  provenance: string; // json object
  isRead: number;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceAttachmentsTable {
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

export interface PeopleTable {
  id: string;
  workspaceId: string;
  displayName: string;
  emails: string; // json string[]
  handles: string; // json string[]
  organizationId: string | null;
  title: string | null;
  importance: string;
  isSelf: number;
  interactionCount: number;
  lastInteractionAt: string | null;
  notes: string | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationsTable {
  id: string;
  workspaceId: string;
  name: string;
  domains: string; // json string[]
  notes: string | null;
  createdAt: string;
}

export interface ProjectsTable {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  keywords: string; // json string[]
  stakeholderPeopleIds: string; // json string[]
  dueAt: string | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCandidatesTable {
  id: string;
  workspaceId: string;
  sourceItemId: string | null;
  title: string;
  description: string | null;
  status: string;
  dueAt: string | null;
  deferredUntil: string | null;
  importanceScore: number;
  urgencyScore: number;
  effortScore: number;
  overallScore: number;
  priorityLevel: string;
  urgencyLevel: string;
  effortLevel: string;
  planningCategory: string;
  signals: string; // json ScoreSignal[]
  explanation: string | null;
  recommendedAction: string | null;
  projectId: string | null;
  peopleIds: string; // json string[]
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export interface DigestsTable {
  id: string;
  workspaceId: string;
  userId: string;
  kind: string;
  status: string;
  generatedAt: string | null;
  periodStart: string;
  periodEnd: string;
  summaryMarkdown: string | null;
  planMarkdown: string | null;
  modelUsed: string | null;
  stats: string; // json object
  supersedesDigestId: string | null;
  error: string | null;
  createdAt: string;
}

export interface DigestItemsTable {
  id: string;
  digestId: string;
  workspaceId: string;
  sourceItemId: string | null;
  taskCandidateId: string | null;
  title: string;
  sourceLabel: string;
  sourceCategory: string | null;
  itemTimestamp: string | null;
  section: string;
  planningCategory: string;
  priorityLevel: string;
  urgencyLevel: string;
  effortLevel: string;
  recommendedAction: string | null;
  explanation: string;
  signals: string; // json ScoreSignal[]
  rank: number;
  createdAt: string;
}

export interface UserPreferencesTable {
  id: string;
  workspaceId: string;
  userId: string;
  key: string;
  value: string; // json
  kind: string;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntriesTable {
  id: string;
  workspaceId: string;
  userId: string;
  kind: string;
  content: string;
  origin: string;
  confidence: number;
  enabled: number;
  relatedPeopleIds: string; // json string[]
  relatedProjectIds: string; // json string[]
  provenance: string; // json object
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionPoliciesTable {
  id: string;
  workspaceId: string;
  userId: string;
  capability: string;
  effect: string;
  scope: string; // json object
  description: string | null;
  createdBy: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestsTable {
  id: string;
  workspaceId: string;
  userId: string;
  agentActionId: string;
  capability: string;
  actionType: string;
  targetProvider: string | null;
  targetAccountId: string | null;
  targetRef: string; // json object
  riskLevel: string;
  reason: string;
  preview: string; // json object
  status: string;
  requestedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  conversationId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogsTable {
  id: string;
  workspaceId: string;
  userId: string | null;
  eventType: string;
  actor: string;
  capability: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  metadata: string; // json object
  createdAt: string;
}

export interface ConversationsTable {
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

export interface MessagesTable {
  id: string;
  conversationId: string;
  workspaceId: string;
  role: string;
  content: string;
  citations: string; // json Citation[]
  suggestedActions: string; // json SuggestedAction[]
  status: string;
  modelUsed: string | null;
  llmCallId: string | null;
  error: string | null;
  createdAt: string;
}

export interface UploadedFilesTable {
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
  status: string;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRunsTable {
  id: string;
  workspaceId: string;
  accountId: string;
  mode: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  errorCount: number;
  errors: string; // json string[]
  cursorBefore: string | null;
  cursorAfter: string | null;
  log: string | null;
  triggeredBy: string;
  createdAt: string;
}

export interface LlmProviderConfigsTable {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  model: string;
  apiKeyEnv: string | null;
  apiKeyEncrypted: string | null;
  temperature: number | null;
  maxTokens: number | null;
  timeoutMs: number | null;
  extraHeaders: string; // json Record<string,string>
  enabled: number;
  isLocal: number;
  supportsEmbeddings: number;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmTaskRoutesTable {
  id: string;
  workspaceId: string;
  task: string;
  providerConfigId: string | null;
  modelOverride: string | null;
  params: string; // json object
  createdAt: string;
  updatedAt: string;
}

export interface LlmCallLogsTable {
  id: string;
  workspaceId: string;
  userId: string | null;
  providerConfigId: string | null;
  providerKind: string;
  model: string;
  task: string;
  status: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  requestSummary: string; // json object
  purposeRef: string; // json object
  createdAt: string;
}

export interface RetrievalChunksTable {
  id: string;
  workspaceId: string;
  sourceType: string;
  refId: string;
  chunkIndex: number;
  text: string;
  metadata: string; // json object
  createdAt: string;
}

export interface EmbeddingRecordsTable {
  id: string;
  workspaceId: string;
  chunkId: string;
  providerConfigId: string | null;
  model: string;
  dims: number;
  vector: string; // json number[]
  createdAt: string;
}

export interface AgentActionsTable {
  id: string;
  workspaceId: string;
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  capability: string;
  actionType: string;
  params: string; // json object
  target: string; // json object
  status: string;
  riskLevel: string;
  policyId: string | null;
  approvalRequestId: string | null;
  result: string | null; // json object
  error: string | null;
  executedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemFeedbackTable {
  id: string;
  workspaceId: string;
  userId: string;
  sourceItemId: string | null;
  taskCandidateId: string | null;
  digestItemId: string | null;
  kind: string;
  note: string | null;
  createdAt: string;
}

export interface LearningSignalsTable {
  id: string;
  workspaceId: string;
  userId: string;
  kind: string;
  key: string;
  value: string;
  strength: number;
  scope: string; // json LearningScope
  detail: string | null;
  source: string; // json SignalSource
  observedAt: string;
  processed: number; // 0|1
  createdAt: string;
}

export interface LearnedPreferencesTable {
  id: string;
  workspaceId: string;
  userId: string;
  category: string;
  key: string;
  value: string;
  statement: string;
  scope: string; // json LearningScope
  scopeKey: string; // canonical scope serialization (uniqueness)
  origin: string; // 'explicit' | 'feedback' | 'inferred'
  status: string; // 'active' | 'rejected' | 'retired'
  confidence: number;
  evidenceCount: number;
  evidenceWeight: number;
  contradictionCount: number;
  pinned: number; // 0|1
  decayHalfLifeDays: number;
  lastReinforcedAt: string;
  explanation: string;
  sources: string; // json SignalSource[]
  contradictions: string; // json SignalSource[]
  userNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettingsTable {
  id: string;
  workspaceId: string;
  key: string;
  value: string; // json
  updatedAt: string;
}

export interface DB {
  users: UsersTable;
  workspaces: WorkspacesTable;
  authAccounts: AuthAccountsTable;
  sessions: SessionsTable;
  oauthTokens: OauthTokensTable;
  sourceAccounts: SourceAccountsTable;
  sourceItems: SourceItemsTable;
  sourceAttachments: SourceAttachmentsTable;
  people: PeopleTable;
  organizations: OrganizationsTable;
  projects: ProjectsTable;
  taskCandidates: TaskCandidatesTable;
  digests: DigestsTable;
  digestItems: DigestItemsTable;
  userPreferences: UserPreferencesTable;
  memoryEntries: MemoryEntriesTable;
  permissionPolicies: PermissionPoliciesTable;
  approvalRequests: ApprovalRequestsTable;
  auditLogs: AuditLogsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  uploadedFiles: UploadedFilesTable;
  connectorRuns: ConnectorRunsTable;
  llmProviderConfigs: LlmProviderConfigsTable;
  llmTaskRoutes: LlmTaskRoutesTable;
  llmCallLogs: LlmCallLogsTable;
  retrievalChunks: RetrievalChunksTable;
  embeddingRecords: EmbeddingRecordsTable;
  agentActions: AgentActionsTable;
  itemFeedback: ItemFeedbackTable;
  appSettings: AppSettingsTable;
  learningSignals: LearningSignalsTable;
  learnedPreferences: LearnedPreferencesTable;
}
