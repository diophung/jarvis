import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    send = sendMock;
  }
  class FakeListObjectsV2Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return { S3Client: FakeS3Client, ListObjectsV2Command: FakeListObjectsV2Command };
});

// Import after vi.mock so the connector picks up the fake SDK.
const { S3Connector, mapS3Object } = await import('./s3.js');
const { makeCtx } = await import('../test-helpers.js');

const S3_ENV = {
  DONNA_SOURCE_S3_BUCKET: 'meridian-docs',
  DONNA_SOURCE_S3_REGION: 'us-east-1',
};

beforeEach(() => {
  sendMock.mockReset();
});

describe('S3Connector healthCheck', () => {
  it('reports not configured with missing env names', async () => {
    const connector = new S3Connector();
    const health = await connector.healthCheck(makeCtx());
    expect(health.ok).toBe(false);
    expect(health.message).toBe(
      'not configured: missing env DONNA_SOURCE_S3_BUCKET, DONNA_SOURCE_S3_REGION',
    );
  });

  it('lists one object when configured', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const connector = new S3Connector();
    const health = await connector.healthCheck(makeCtx({ secretValues: S3_ENV }));
    expect(health.ok).toBe(true);
    expect(health.message).toContain('meridian-docs');
  });
});

describe('S3Connector sync (SDK-mocked)', () => {
  it('maps listed objects to storage RawSourceItems and paginates by ContinuationToken', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [
        {
          Key: 'contracts/Northwind-MSA-v4.docx',
          LastModified: new Date('2026-06-08T12:00:00.000Z'),
          Size: 482133,
          ETag: '"abc123"',
          StorageClass: 'STANDARD',
        },
        { Key: 'contracts/', Size: 0 }, // folder placeholder — skipped
      ],
      IsTruncated: true,
      NextContinuationToken: 'token-2',
    });

    const connector = new S3Connector();
    const ctx = makeCtx({ secretValues: S3_ENV });
    const page = await connector.sync(ctx, { mode: 'full', limit: 10 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      externalId: 'contracts/Northwind-MSA-v4.docx',
      category: 'storage',
      title: 'Northwind-MSA-v4.docx',
      timestamp: '2026-06-08T12:00:00.000Z',
      url: 's3://meridian-docs/contracts/Northwind-MSA-v4.docx',
      dedupeHint: '"abc123"',
    });
    expect(page.items[0]?.raw).toMatchObject({ sizeBytes: 482133, storageClass: 'STANDARD' });
    expect(page.done).toBe(false);
    expect(JSON.parse(page.nextCursor ?? '{}')).toMatchObject({ token: 'token-2' });

    // The command received bucket + limit.
    const command = sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({ Bucket: 'meridian-docs', MaxKeys: 10 });
  });

  it('incremental sync filters client-side on the persisted LastModified watermark', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [
        { Key: 'old.txt', LastModified: new Date('2026-06-01T00:00:00.000Z') },
        { Key: 'new.txt', LastModified: new Date('2026-06-09T00:00:00.000Z') },
      ],
      IsTruncated: false,
    });

    const connector = new S3Connector();
    const ctx = makeCtx({ secretValues: S3_ENV });
    const page = await connector.sync(ctx, {
      mode: 'incremental',
      cursor: JSON.stringify({ sinceIso: '2026-06-05T00:00:00.000Z' }),
    });

    expect(page.items.map((i) => i.externalId)).toEqual(['new.txt']);
    expect(page.done).toBe(true);
    expect(JSON.parse(page.nextCursor ?? '{}')).toEqual({
      sinceIso: '2026-06-09T00:00:00.000Z',
    });
  });

  it('throws a clear error when synced while unconfigured', async () => {
    const connector = new S3Connector();
    await expect(connector.sync(makeCtx(), { mode: 'full' })).rejects.toThrow(
      /not configured: missing env/,
    );
  });
});

describe('mapS3Object', () => {
  it('returns null for folder keys and missing keys', () => {
    expect(mapS3Object('b', {})).toBeNull();
    expect(mapS3Object('b', { Key: 'folder/' })).toBeNull();
  });
});
