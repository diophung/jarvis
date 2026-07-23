/**
 * AWS S3 source connector hook — treats an S3 bucket as a document source.
 *
 * Untested-against-live-API hook: uses @aws-sdk/client-s3 ListObjectsV2 with
 * standard pagination (ContinuationToken). Credentials come from the default
 * AWS provider chain (env vars, shared config, or an IAM role) — Jarvis never
 * stores them. Required Jarvis env: JARVIS_SOURCE_S3_BUCKET and
 * JARVIS_SOURCE_S3_REGION (resolved via ctx.secrets; per-account overrides via
 * ctx.settings.bucket / ctx.settings.region / ctx.settings.prefix).
 *
 * Incremental model: S3 cannot filter ListObjectsV2 by modification time, so
 * pages are filtered client-side against the persisted max LastModified.
 */
import { ListObjectsV2Command, S3Client, type _Object } from '@aws-sdk/client-s3';
import type { RawSourceItem } from '@jarvis/core';
import type {
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorHealth,
  SyncPage,
  SyncRequest,
} from '../types.js';
import { parseJsonCursor } from '../util/parse.js';

export const S3_REQUIRED_ENV = ['JARVIS_SOURCE_S3_BUCKET', 'JARVIS_SOURCE_S3_REGION'] as const;

const DEFAULT_LIMIT = 50;

interface S3Cursor extends Record<string, unknown> {
  /** Mid-run ListObjectsV2 ContinuationToken. */
  token?: string;
  /** ISO LastModified lower bound for incremental syncs. */
  sinceIso?: string;
  maxModifiedIso?: string;
}

export class S3Connector implements Connector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 's3',
    category: 'storage',
    label: 'AWS S3',
    description:
      'Documents in an S3 bucket (read-only listing). AWS credentials come from the default provider chain.',
    capabilities: ['read', 'list'],
    scopes: ['s3:ListBucket', 's3:GetObject'],
    requiredEnv: [...S3_REQUIRED_ENV],
    local: false,
  };

  private client: S3Client | null = null;
  private clientRegion: string | null = null;

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const missing = this.missingEnv(ctx);
    if (missing.length > 0) {
      return { ok: false, message: `not configured: missing env ${missing.join(', ')}` };
    }
    try {
      const { bucket, region } = this.resolveTarget(ctx);
      const client = this.getClient(region);
      await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
      return { ok: true, message: `S3 bucket reachable (${bucket}, ${region})` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'S3 health check failed' };
    }
  }

  async sync(ctx: ConnectorContext, req: SyncRequest): Promise<SyncPage> {
    const missing = this.missingEnv(ctx);
    if (missing.length > 0) {
      throw new Error(`not configured: missing env ${missing.join(', ')}`);
    }
    const { bucket, region, prefix } = this.resolveTarget(ctx);
    const limit = req.limit !== undefined && req.limit > 0 ? req.limit : DEFAULT_LIMIT;
    const cursor = parseJsonCursor<S3Cursor>(req.cursor) ?? {};
    const sinceIso = req.mode === 'incremental' ? cursor.sinceIso : undefined;

    const client = this.getClient(region);
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: limit,
        ...(typeof cursor.token === 'string' && cursor.token
          ? { ContinuationToken: cursor.token }
          : {}),
        ...(prefix ? { Prefix: prefix } : {}),
      }),
    );

    const items: RawSourceItem[] = [];
    let maxModifiedIso = cursor.maxModifiedIso ?? sinceIso ?? '';
    for (const obj of out.Contents ?? []) {
      const item = mapS3Object(bucket, obj);
      if (!item) continue;
      if (typeof sinceIso === 'string' && sinceIso && item.timestamp <= sinceIso) continue;
      items.push(item);
      if (item.timestamp > maxModifiedIso) maxModifiedIso = item.timestamp;
    }

    const done = out.IsTruncated !== true;
    const nextCursor: S3Cursor = done
      ? { sinceIso: maxModifiedIso || undefined }
      : { token: out.NextContinuationToken, sinceIso, maxModifiedIso };
    return { items, nextCursor: JSON.stringify(nextCursor), done };
  }

  private missingEnv(ctx: ConnectorContext): string[] {
    // Per-account settings can stand in for the env vars.
    const hasBucket =
      typeof ctx.settings['bucket'] === 'string' || !!ctx.secrets.get('JARVIS_SOURCE_S3_BUCKET');
    const hasRegion =
      typeof ctx.settings['region'] === 'string' || !!ctx.secrets.get('JARVIS_SOURCE_S3_REGION');
    const missing: string[] = [];
    if (!hasBucket) missing.push('JARVIS_SOURCE_S3_BUCKET');
    if (!hasRegion) missing.push('JARVIS_SOURCE_S3_REGION');
    return missing;
  }

  private resolveTarget(ctx: ConnectorContext): {
    bucket: string;
    region: string;
    prefix: string | undefined;
  } {
    const settingsBucket = ctx.settings['bucket'];
    const settingsRegion = ctx.settings['region'];
    const settingsPrefix = ctx.settings['prefix'];
    return {
      bucket:
        typeof settingsBucket === 'string' && settingsBucket
          ? settingsBucket
          : (ctx.secrets.get('JARVIS_SOURCE_S3_BUCKET') ?? ''),
      region:
        typeof settingsRegion === 'string' && settingsRegion
          ? settingsRegion
          : (ctx.secrets.get('JARVIS_SOURCE_S3_REGION') ?? ''),
      prefix: typeof settingsPrefix === 'string' && settingsPrefix ? settingsPrefix : undefined,
    };
  }

  private getClient(region: string): S3Client {
    if (!this.client || this.clientRegion !== region) {
      this.client = new S3Client({ region });
      this.clientRegion = region;
    }
    return this.client;
  }
}

/** Map an S3 object listing entry to Jarvis's RawSourceItem. */
export function mapS3Object(bucket: string, obj: _Object): RawSourceItem | null {
  const key = obj.Key;
  if (!key || key.endsWith('/')) return null; // skip folder placeholders
  const filename = key.split('/').pop() ?? key;
  const item: RawSourceItem = {
    externalId: key,
    category: 'storage',
    title: filename,
    timestamp: obj.LastModified ? obj.LastModified.toISOString() : new Date(0).toISOString(),
    url: `s3://${bucket}/${key}`,
    raw: {
      provider: 's3',
      key,
      sizeBytes: obj.Size ?? null,
      etag: obj.ETag ?? null,
      storageClass: obj.StorageClass ?? null,
    },
  };
  if (obj.ETag) item.dedupeHint = obj.ETag;
  return item;
}
