/**
 * File storage: local filesystem by default, S3 when JARVIS_STORAGE_DRIVER=s3.
 *
 * storagePath values are self-describing — 's3://bucket/key' for S3 objects,
 * a filesystem path otherwise — so read()/remove() dispatch on the prefix
 * regardless of the currently configured driver.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { StorageService } from '../context.js';

const S3_PREFIX = 's3://';
const MAX_FILENAME_LENGTH = 100;

/** Keep only filesystem/url-safe characters; preserve the extension by trimming from the front. */
function safeFilename(filename: string): string {
  const cleaned = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const trimmed = cleaned.slice(-MAX_FILENAME_LENGTH);
  return trimmed === '' ? 'file' : trimmed;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function parseS3Path(storagePath: string): { bucket: string; key: string } {
  const rest = storagePath.slice(S3_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash === -1 || slash === 0 || slash === rest.length - 1) {
    throw new Error(`Invalid S3 storage path: ${storagePath}`);
  }
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

export function createStorageService(deps: { config: AppConfig }): StorageService {
  const { config } = deps;
  const env = config.env;
  const useS3 = env.JARVIS_STORAGE_DRIVER === 's3';

  let s3Client: S3Client | null = null;
  function s3(): S3Client {
    if (s3Client === null) {
      s3Client = new S3Client({
        region: env.JARVIS_S3_REGION ?? 'us-east-1',
        ...(env.JARVIS_S3_ENDPOINT !== undefined && env.JARVIS_S3_ENDPOINT !== ''
          ? { endpoint: env.JARVIS_S3_ENDPOINT, forcePathStyle: true }
          : {}),
      });
    }
    return s3Client;
  }

  function s3Bucket(): string {
    const bucket = env.JARVIS_S3_BUCKET;
    if (bucket === undefined || bucket === '') {
      throw new Error('JARVIS_S3_BUCKET must be set when JARVIS_STORAGE_DRIVER=s3');
    }
    return bucket;
  }

  return {
    async save(workspaceId, filename, data) {
      const name = `${randomBytes(8).toString('hex')}-${safeFilename(filename)}`;
      const sha256 = sha256Hex(data);
      if (useS3) {
        const bucket = s3Bucket();
        const key = `${workspaceId}/${name}`;
        await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data }));
        return { storagePath: `${S3_PREFIX}${bucket}/${key}`, sizeBytes: data.length, sha256 };
      }
      const dir = path.join(config.uploadsDir, workspaceId);
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, name);
      await writeFile(filePath, data);
      return { storagePath: filePath, sizeBytes: data.length, sha256 };
    },

    async read(storagePath) {
      if (storagePath.startsWith(S3_PREFIX)) {
        const { bucket, key } = parseS3Path(storagePath);
        const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (res.Body === undefined) {
          throw new Error(`Empty S3 response body for ${storagePath}`);
        }
        return Buffer.from(await res.Body.transformToByteArray());
      }
      return readFile(storagePath);
    },

    async remove(storagePath) {
      if (storagePath.startsWith(S3_PREFIX)) {
        const { bucket, key } = parseS3Path(storagePath);
        // DeleteObject is idempotent; tolerate already-missing objects.
        await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return;
      }
      try {
        await unlink(storagePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}
