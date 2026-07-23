import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../config.js';
import { createStorageService } from './storage.js';

describe('storage service (local driver)', () => {
  let dir: string;
  let config: AppConfig;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jarvis-storage-'));
    config = loadConfig({ JARVIS_DATA_DIR: dir, JARVIS_STORAGE_DRIVER: 'local' });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips save/read/remove with a stable sha256', async () => {
    const storage = createStorageService({ config });
    const data = Buffer.from('hello jarvis storage', 'utf8');

    const saved = await storage.save('wsp_test', 'My Report (final).txt', data);
    expect(saved.sizeBytes).toBe(data.length);
    expect(saved.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    // Files live under uploadsDir/<workspaceId>/<random>-<safe filename>.
    expect(saved.storagePath.startsWith(path.join(dir, 'uploads', 'wsp_test'))).toBe(true);
    const basename = path.basename(saved.storagePath);
    expect(basename).not.toContain('(');
    expect(basename).not.toContain(' ');
    expect(basename.endsWith('.txt')).toBe(true);
    await expect(stat(saved.storagePath)).resolves.toBeDefined();

    const read = await storage.read(saved.storagePath);
    expect(read.equals(data)).toBe(true);

    await storage.remove(saved.storagePath);
    await expect(storage.read(saved.storagePath)).rejects.toThrow();
    // Removing a missing file is tolerated.
    await expect(storage.remove(saved.storagePath)).resolves.toBeUndefined();
  });

  it('computes the same sha256 for identical content at different paths', async () => {
    const storage = createStorageService({ config });
    const data = Buffer.from('identical bytes', 'utf8');
    const a = await storage.save('wsp_a', 'one.txt', data);
    const b = await storage.save('wsp_b', 'two.txt', data);
    expect(a.sha256).toBe(b.sha256);
    expect(a.storagePath).not.toBe(b.storagePath);
  });

  it('uses unique storage paths for repeated saves of the same filename', async () => {
    const storage = createStorageService({ config });
    const a = await storage.save('wsp_test', 'same.txt', Buffer.from('a'));
    const b = await storage.save('wsp_test', 'same.txt', Buffer.from('b'));
    expect(a.storagePath).not.toBe(b.storagePath);
    expect((await storage.read(a.storagePath)).toString()).toBe('a');
    expect((await storage.read(b.storagePath)).toString()).toBe('b');
  });
});
