/**
 * Connector abstraction. A connector adapts one provider (gmail, slack,
 * mock-email, s3, ...) to Donna's normalized ingestion contract.
 *
 * Secrets NEVER live in connector code or the DB — connectors resolve
 * credentials at call time through the SecretResolver (env vars or a secret
 * manager behind it).
 */
import type { ConnectorCapability, RawSourceItem, SourceCategory } from '@donna/core';

export interface SecretResolver {
  /** Resolve a secret by reference (usually an env var name). */
  get(ref: string): string | undefined;
}

export interface ConnectorLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface ConnectorContext {
  accountId: string;
  workspaceId: string;
  /** Per-account settings (non-secret), e.g. { bucket: 'x', channelIds: [...] }. */
  settings: Record<string, unknown>;
  secrets: SecretResolver;
  logger: ConnectorLogger;
}

export interface SyncRequest {
  mode: 'full' | 'incremental';
  /** Opaque cursor from the previous run (null/undefined = start). */
  cursor?: string | null;
  /** Soft limit on items per page. */
  limit?: number;
}

export interface SyncPage {
  items: RawSourceItem[];
  /** Cursor to persist for the next incremental run. */
  nextCursor: string | null;
  /** True when there are no more pages in this run. */
  done: boolean;
}

export interface ConnectorHealth {
  ok: boolean;
  message: string;
}

export interface ConnectorDescriptor {
  /** Stable provider id, e.g. 'gmail', 'mock-email', 's3'. */
  provider: string;
  category: SourceCategory;
  label: string;
  description: string;
  capabilities: ConnectorCapability[];
  /** OAuth scopes / IAM permissions this connector needs (least privilege). */
  scopes: string[];
  /** Env vars required for a real connection (empty for mock connectors). */
  requiredEnv: string[];
  /** True when no external credentials/network are needed (mock/local). */
  local: boolean;
}

/** A write-side action a connector can execute (only via the approval flow). */
export interface ConnectorAction {
  type: string; // e.g. 'send_email', 'create_event', 'post_message'
  params: Record<string, unknown>;
}

export interface ConnectorActionResult {
  ok: boolean;
  detail?: string;
  externalRef?: string;
}

export interface AttachmentContent {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface Connector {
  readonly descriptor: ConnectorDescriptor;
  healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth>;
  /** Fetch one page of items; the ingestion pipeline loops until done. */
  sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage>;
  fetchItem?(ctx: ConnectorContext, externalId: string): Promise<RawSourceItem | null>;
  fetchAttachment?(ctx: ConnectorContext, externalRef: string): Promise<AttachmentContent | null>;
  /** Execute a write action. MUST only be called after policy/approval checks. */
  execute?(ctx: ConnectorContext, action: ConnectorAction): Promise<ConnectorActionResult>;
}

export const envSecretResolver: SecretResolver = {
  get(ref: string): string | undefined {
    return process.env[ref];
  },
};

export const consoleConnectorLogger: ConnectorLogger = {
  info: (msg) => console.log(`[connector] ${msg}`),
  warn: (msg) => console.warn(`[connector] ${msg}`),
  error: (msg) => console.error(`[connector] ${msg}`),
};
