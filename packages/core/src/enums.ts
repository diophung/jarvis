/**
 * Core enums / string unions shared across the whole system.
 * Keep these as string unions (not TS enums) so they serialize cleanly
 * and stay portable between DB, API, and UI.
 */

export const SOURCE_CATEGORIES = ['email', 'chat', 'calendar', 'storage', 'upload'] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/** Connector-level data capabilities (what a connector can do against its provider). */
export const CONNECTOR_CAPABILITIES = [
  'read',
  'list',
  'search',
  'download',
  'create',
  'update',
  'delete',
  'send',
  'invite',
  'share',
  'upload',
  'comment',
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export const RISK_LEVELS = ['safe', 'low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const POLICY_EFFECTS = ['auto_approve', 'require_approval', 'deny'] as const;
export type PolicyEffect = (typeof POLICY_EFFECTS)[number];

export const PLANNING_CATEGORIES = [
  'do_now',
  'prepare_today',
  'waiting_on_others',
  'decide',
  'read_when_possible',
  'follow_up',
  'low_priority',
] as const;
export type PlanningCategory = (typeof PLANNING_CATEGORIES)[number];

export const PLANNING_CATEGORY_LABELS: Record<PlanningCategory, string> = {
  do_now: 'Do Now',
  prepare_today: 'Prepare Today',
  waiting_on_others: 'Waiting on Others',
  decide: 'Decide',
  read_when_possible: 'Read When Possible',
  follow_up: 'Follow Up',
  low_priority: 'Low Priority',
};

export const LEVELS = ['critical', 'high', 'medium', 'low'] as const;
/** Discrete level used for priority, urgency, and effort displays. */
export type Level = (typeof LEVELS)[number];

export const LLM_TASKS = ['chat', 'summarization', 'digest', 'classification', 'embedding'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

export const LLM_PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'gemini',
  'openai_compatible',
  'mock',
] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const AGENT_ACTION_STATUSES = [
  'proposed',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'denied',
  'executing',
  'executed',
  'failed',
  'cancelled',
] as const;
export type AgentActionStatus = (typeof AGENT_ACTION_STATUSES)[number];

export const CONNECTOR_RUN_STATUSES = ['running', 'success', 'partial', 'error'] as const;
export type ConnectorRunStatus = (typeof CONNECTOR_RUN_STATUSES)[number];

export const SOURCE_ACCOUNT_STATUSES = [
  'connected',
  'disconnected',
  'error',
  'needs_auth',
] as const;
export type SourceAccountStatus = (typeof SOURCE_ACCOUNT_STATUSES)[number];

export const FEEDBACK_KINDS = [
  'important',
  'not_important',
  'urgent',
  'not_urgent',
  'done',
  'deferred',
  'incorrect',
  'more_like_this',
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const MEMORY_KINDS = [
  'preference',
  'fact',
  'person',
  'project',
  'behavior',
  'instruction',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const TASK_CANDIDATE_STATUSES = ['open', 'done', 'deferred', 'dismissed'] as const;
export type TaskCandidateStatus = (typeof TASK_CANDIDATE_STATUSES)[number];

export const DIGEST_STATUSES = ['generating', 'ready', 'error'] as const;
export type DigestStatus = (typeof DIGEST_STATUSES)[number];

export const DIGEST_KINDS = ['daily', 'manual', 'scheduled'] as const;
export type DigestKind = (typeof DIGEST_KINDS)[number];

/** Sections of the daily debrief, in display order. */
export const DIGEST_SECTIONS = [
  'most_important',
  'most_urgent',
  'high_effort',
  'meetings_prep',
  'follow_ups',
  'missed',
  'reading',
  'risks',
] as const;
export type DigestSection = (typeof DIGEST_SECTIONS)[number];

export const DIGEST_SECTION_LABELS: Record<DigestSection, string> = {
  most_important: 'Most Important',
  most_urgent: 'Most Urgent',
  high_effort: 'High-Effort Work',
  meetings_prep: 'Meetings Needing Prep',
  follow_ups: 'Unresolved Follow-ups',
  missed: 'Missed or Ignored',
  reading: 'Worth Reading',
  risks: 'Risks & Blockers',
};

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const ACTOR_TYPES = ['user', 'agent', 'system', 'worker'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const PERSON_IMPORTANCES = ['vip', 'high', 'normal', 'low', 'ignore'] as const;
export type PersonImportance = (typeof PERSON_IMPORTANCES)[number];

export const AUDIT_EVENT_TYPES = [
  'connector.connected',
  'connector.disconnected',
  'connector.sync',
  'source.access',
  'file.uploaded',
  'file.access',
  'file.deleted',
  'digest.generated',
  'digest.viewed',
  'memory.created',
  'memory.updated',
  'memory.deleted',
  'memory.toggled',
  'llm.call',
  'agent.action.proposed',
  'agent.action.executed',
  'agent.action.failed',
  'approval.created',
  'approval.approved',
  'approval.denied',
  'approval.expired',
  'policy.updated',
  'preference.updated',
  'feedback.recorded',
  'settings.updated',
  'auth.login',
  'auth.logout',
  'auth.register',
  'auth.login_failed',
  'auth.password_changed',
  'auth.oauth_linked',
  'auth.oauth_unlinked',
  'auth.session_revoked',
  'source.oauth_connected',
  'source.oauth_disconnected',
  'source.token_refresh_failed',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** OAuth providers usable for LOGIN (authentication, not data access). */
export const OAUTH_LOGIN_PROVIDERS = ['google', 'facebook', 'apple'] as const;
export type OauthLoginProvider = (typeof OAUTH_LOGIN_PROVIDERS)[number];

/**
 * Google data sources connectable via per-source OAuth authorization.
 * Values double as the connector provider ids so a granted token maps 1:1
 * onto a sourceAccounts row.
 */
export const GOOGLE_SOURCE_TYPES = ['gmail', 'google-drive', 'google-calendar'] as const;
export type GoogleSourceType = (typeof GOOGLE_SOURCE_TYPES)[number];

export const OAUTH_TOKEN_STATUSES = ['active', 'needs_reauth', 'revoked'] as const;
export type OauthTokenStatus = (typeof OAUTH_TOKEN_STATUSES)[number];
