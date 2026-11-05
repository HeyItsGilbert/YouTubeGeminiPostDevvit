import { describe, expect, it } from 'vitest';
import {
  REGISTRY_KEY,
  deleteVideoRecord,
  findVideoByPostId,
  getAllVideoRecords,
  setVideoRecord,
} from './videoRegistry.js';
import type { VideoRecord } from '../types.js';

/** Map-backed fake Redis hash — only the hash commands videoRegistry.ts uses. */
function createFakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  return {
    hashes,
    async hGet(key: string, field: string): Promise<string | undefined> {
      return hashes.get(key)?.get(field);
    },
    async hGetAll(key: string): Promise<Record<string, string>> {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hSet(key: string, values: Record<string, string>): Promise<number> {
      const hash = hashes.get(key) ?? new Map<string, string>();
      let added = 0;
      for (const [field, value] of Object.entries(values)) {
        if (!hash.has(field)) added++;
        hash.set(field, value);
      }
      hashes.set(key, hash);
      return added;
    },
    async hDel(key: string, fields: string[]): Promise<number> {
      const hash = hashes.get(key);
      if (!hash) return 0;
      let removed = 0;
      for (const field of fields) {
        if (hash.delete(field)) removed++;
      }
      return removed;
    },
  };
}

const record = (overrides: Partial<VideoRecord> = {}): VideoRecord => ({
  title: 'Episode 1',
  status: 'skipped',
  processedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('setVideoRecord', () => {
  it('writes a fresh record', async () => {
    const redis = createFakeRedis();
    const wrote = await setVideoRecord(redis, 'vid1', record({ status: 'excluded' }));
    expect(wrote).toBe(true);
    const all = await getAllVideoRecords(redis);
    expect(all.vid1?.status).toBe('excluded');
  });

  it('allows overwriting a non-posted record with another non-posted status', async () => {
    const redis = createFakeRedis();
    await setVideoRecord(redis, 'vid1', record({ status: 'skipped' }));
    const wrote = await setVideoRecord(redis, 'vid1', record({ status: 'excluded' }));
    expect(wrote).toBe(true);
    expect((await getAllVideoRecords(redis)).vid1?.status).toBe('excluded');
  });

  it('refuses to overwrite a posted record with a non-posted status', async () => {
    const redis = createFakeRedis();
    await setVideoRecord(redis, 'vid1', record({ status: 'posted', postId: 't3_abc' }));
    const wrote = await setVideoRecord(redis, 'vid1', record({ status: 'skipped' }));
    expect(wrote).toBe(false);
    const all = await getAllVideoRecords(redis);
    expect(all.vid1?.status).toBe('posted');
    expect(all.vid1?.postId).toBe('t3_abc');
  });

  it('allows a posted record to replace another posted record (forced repost)', async () => {
    const redis = createFakeRedis();
    await setVideoRecord(redis, 'vid1', record({ status: 'posted', postId: 't3_old' }));
    const wrote = await setVideoRecord(redis, 'vid1', record({ status: 'posted', postId: 't3_new' }));
    expect(wrote).toBe(true);
    expect((await getAllVideoRecords(redis)).vid1?.postId).toBe('t3_new');
  });
});

describe('deleteVideoRecord', () => {
  it('removes a non-posted record', async () => {
    const redis = createFakeRedis();
    await setVideoRecord(redis, 'vid1', record({ status: 'rejected' }));
    const deleted = await deleteVideoRecord(redis, 'vid1');
    expect(deleted).toBe(true);
    expect(await getAllVideoRecords(redis)).toEqual({});
  });

  it('refuses to remove a posted record', async () => {
    const redis = createFakeRedis();
    await setVideoRecord(redis, 'vid1', record({ status: 'posted', postId: 't3_abc' }));
    const deleted = await deleteVideoRecord(redis, 'vid1');
    expect(deleted).toBe(false);
    expect((await getAllVideoRecords(redis)).vid1?.status).toBe('posted');
  });

  it('is a no-op (returns true) for a video with no record', async () => {
    const redis = createFakeRedis();
    const deleted = await deleteVideoRecord(redis, 'never-seen');
    expect(deleted).toBe(true);
  });
});

describe('findVideoByPostId', () => {
  it('finds the video whose record carries the given post ID', async () => {
    const redis = createFakeRedis();
    await setVideoRecord(redis, 'vid1', record({ status: 'posted', postId: 't3_abc' }));
    await setVideoRecord(redis, 'vid2', record({ status: 'posted', postId: 't3_def' }));
    const found = await findVideoByPostId(redis, 't3_def');
    expect(found?.videoId).toBe('vid2');
    expect(found?.record.postId).toBe('t3_def');
  });

  it('returns null when no record carries the given post ID', async () => {
    const redis = createFakeRedis();
    await setVideoRecord(redis, 'vid1', record({ status: 'posted', postId: 't3_abc' }));
    expect(await findVideoByPostId(redis, 't3_missing')).toBeNull();
  });
});

describe('getAllVideoRecords', () => {
  it('skips corrupt JSON entries rather than throwing', async () => {
    const redis = createFakeRedis();
    redis.hashes.set(REGISTRY_KEY, new Map([
      ['vid1', JSON.stringify(record())],
      ['vid2', 'not valid json'],
    ]));
    const all = await getAllVideoRecords(redis);
    expect(Object.keys(all)).toEqual(['vid1']);
  });
});
