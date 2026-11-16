import { describe, expect, it } from 'vitest';
import type { VideoRecord } from '../types.js';
import { REGISTRY_KEY } from './videoRegistry.js';
import {
  PENDING_POST_LEASE_MS,
  REDIS_KEY_PENDING_POST,
  REDIS_KEY_PENDING_POST_JOB_ID,
  buildReviewPendingPostForm,
  claimPendingPost,
  completePendingPostPublication,
  enqueuePendingPost,
  getPendingPost,
  migrateLegacyAutoApproveJob,
  parsePendingPostTarget,
  parseReviewAction,
  reserveAutoApproveJob,
  resolvePendingPost,
  savePendingPostPublication,
  updatePendingPostForReview,
  type PendingPost,
} from './pendingPost.js';

/** Map-backed Redis fake with optimistic transactions, including hash writes. */
function createAtomicFakeContext(
  initial: Record<string, string> = {},
  initialRegistry: Record<string, string> = {},
) {
  const store = new Map<string, string>(Object.entries(initial));
  const registry = new Map<string, string>(Object.entries(initialRegistry));
  const versions = new Map<string, number>();
  const bump = (key: string) => versions.set(key, (versions.get(key) ?? 0) + 1);
  const redis = {
    get: async (key: string): Promise<string | undefined> => store.get(key),
    set: async (key: string, value: string): Promise<void> => {
      store.set(key, value);
      bump(key);
    },
    del: async (...keys: string[]): Promise<void> => {
      keys.forEach((key) => {
        store.delete(key);
        bump(key);
      });
    },
    hGet: async (key: string, field: string): Promise<string | undefined> => {
      if (key !== REGISTRY_KEY) throw new Error(`unexpected hash ${key}`);
      return registry.get(field);
    },
    hSet: async (key: string, values: Record<string, string>): Promise<void> => {
      if (key !== REGISTRY_KEY) throw new Error(`unexpected hash ${key}`);
      Object.entries(values).forEach(([field, value]) => registry.set(field, value));
      bump(key);
    },
    hDel: async (key: string, fields: string[]): Promise<void> => {
      if (key !== REGISTRY_KEY) throw new Error(`unexpected hash ${key}`);
      fields.forEach((field) => registry.delete(field));
      bump(key);
    },
    watch: async (...keys: string[]) => {
      const watched = new Map(keys.map((key) => [key, versions.get(key) ?? 0]));
      const commands: (() => void)[] = [];
      return {
        multi: async () => {},
        set: async (key: string, value: string) => commands.push(() => {
          store.set(key, value);
          bump(key);
        }),
        del: async (...keysToDelete: string[]) => commands.push(() => keysToDelete.forEach((key) => {
          store.delete(key);
          bump(key);
        })),
        hSet: async (key: string, values: Record<string, string>) => commands.push(() => {
          if (key !== REGISTRY_KEY) throw new Error(`unexpected hash ${key}`);
          Object.entries(values).forEach(([field, value]) => registry.set(field, value));
          bump(key);
        }),
        hDel: async (key: string, fields: string[]) => commands.push(() => {
          if (key !== REGISTRY_KEY) throw new Error(`unexpected hash ${key}`);
          fields.forEach((field) => registry.delete(field));
          bump(key);
        }),
        exec: async () => {
          if ([...watched].some(([key, version]) => (versions.get(key) ?? 0) !== version)) return [];
          commands.forEach((command) => command());
          return commands.map(() => 'OK');
        },
        unwatch: async () => {},
      };
    },
  };
  return { redis, store, registry };
}

const pendingPost = (overrides: Partial<PendingPost> = {}): PendingPost => ({
  title: 'New Episode',
  body: 'Discussion body',
  url: 'https://www.youtube.com/watch?v=abc123',
  videoId: 'abc123',
  videoTitle: 'New Episode',
  generatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const targetOf = (pending: PendingPost) => ({
  videoId: pending.videoId,
  generatedAt: pending.generatedAt,
});

describe('getPendingPost', () => {
  it('returns null when nothing is pending', async () => {
    const { redis } = createAtomicFakeContext();
    expect(await getPendingPost(redis)).toBeNull();
  });

  it('returns the parsed pending post when one is stored', async () => {
    const pending = pendingPost();
    const { redis } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(pending) });
    expect(await getPendingPost(redis)).toEqual(pending);
  });
});

describe('pending enqueue', () => {
  it('does not replace a Pending Post queued by a concurrent checker', async () => {
    const replacement = pendingPost({ videoId: 'replacement', generatedAt: '2026-01-02T00:00:00.000Z' });
    const { redis } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(replacement) });

    expect(await enqueuePendingPost(redis, pendingPost())).toEqual({ status: 'occupied' });
    expect(await getPendingPost(redis)).toEqual(replacement);
  });

  it('atomically queues the post and records its video as pending', async () => {
    const pending = pendingPost();
    const { redis, registry } = createAtomicFakeContext();

    expect(await enqueuePendingPost(redis, pending)).toEqual({ status: 'queued' });
    expect(await getPendingPost(redis)).toEqual(pending);
    expect(JSON.parse(registry.get(pending.videoId)!) as VideoRecord).toMatchObject({ status: 'pending' });
  });

  it('refuses to queue a video that became terminal while content was generated', async () => {
    const pending = pendingPost();
    const { redis, registry } = createAtomicFakeContext({}, {
      [pending.videoId]: JSON.stringify({ title: pending.videoTitle, status: 'rejected', processedAt: pending.generatedAt }),
    });

    expect(await enqueuePendingPost(redis, pending)).toEqual({ status: 'ineligible' });
    expect(JSON.parse(registry.get(pending.videoId)!) as VideoRecord).toMatchObject({ status: 'rejected' });
    expect(await getPendingPost(redis)).toBeNull();
  });

  it('allows an explicit force repost to replace a terminal registry record', async () => {
    const pending = pendingPost();
    const { redis, registry } = createAtomicFakeContext({}, {
      [pending.videoId]: JSON.stringify({ title: pending.videoTitle, status: 'posted', processedAt: pending.generatedAt }),
    });

    expect(await enqueuePendingPost(redis, pending, { forceRepost: true })).toEqual({ status: 'queued' });
    expect(JSON.parse(registry.get(pending.videoId)!) as VideoRecord).toMatchObject({ status: 'pending' });
  });

  it('refuses to queue a posted video that became terminal while content was generated', async () => {
    const pending = pendingPost();
    const { redis } = createAtomicFakeContext({}, {
      [pending.videoId]: JSON.stringify({ title: pending.videoTitle, status: 'posted', processedAt: pending.generatedAt }),
    });

    expect(await enqueuePendingPost(redis, pending)).toEqual({ status: 'ineligible' });
    expect(await getPendingPost(redis)).toBeNull();
  });

  it('does not attach a timer to a replacement Pending Post', async () => {
    const replacement = pendingPost({ videoId: 'replacement', generatedAt: '2026-01-02T00:00:00.000Z' });
    const { redis, store } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(replacement) });

    expect(await reserveAutoApproveJob(redis, targetOf(pendingPost()), 'stale-job')).toEqual({ status: 'stale' });
    expect(store.has(REDIS_KEY_PENDING_POST_JOB_ID)).toBe(false);
  });
});

describe('pending publication lease', () => {
  it('recovers a claim after its bounded lease expires', async () => {
    const pending = pendingPost();
    const { redis } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(pending) });
    const startedAt = new Date('2026-01-01T00:00:00.000Z');

    const first = await claimPendingPost(redis, targetOf(pending), { owner: 'first', now: startedAt });
    const stillBusy = await claimPendingPost(redis, targetOf(pending), {
      owner: 'second', now: new Date(startedAt.getTime() + PENDING_POST_LEASE_MS - 1),
    });
    const recovered = await claimPendingPost(redis, targetOf(pending), {
      owner: 'second', now: new Date(startedAt.getTime() + PENDING_POST_LEASE_MS),
    });

    expect(first).toMatchObject({ status: 'claimed', pending: { publicationLease: { owner: 'first' } } });
    expect(stillBusy).toEqual({ status: 'busy' });
    expect(recovered).toMatchObject({ status: 'claimed', pending: { publicationLease: { owner: 'second' } } });
  });

  it('persists each Reddit ID while the owning lease is valid', async () => {
    const pending = pendingPost();
    const { redis } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(pending) });
    const claim = await claimPendingPost(redis, targetOf(pending), { owner: 'publisher' });
    if (claim.status !== 'claimed') throw new Error('expected a claim');

    const afterPost = await savePendingPostPublication(redis, claim.pending, { postId: 't3_post' });
    const afterComment = await savePendingPostPublication(redis, afterPost, { commentId: 't1_comment' });

    expect(afterComment).toMatchObject({ postId: 't3_post', commentId: 't1_comment' });
  });

  it('commits the posted registry record and removes only its owned Pending Post together', async () => {
    const pending = pendingPost();
    const { redis, store, registry } = createAtomicFakeContext({
      [REDIS_KEY_PENDING_POST]: JSON.stringify(pending),
      [REDIS_KEY_PENDING_POST_JOB_ID]: 'timer-1',
    });
    const claim = await claimPendingPost(redis, targetOf(pending), { owner: 'publisher' });
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    const withIds = await savePendingPostPublication(redis, claim.pending, { postId: 't3_post', commentId: 't1_comment' });

    expect(await completePendingPostPublication(redis, withIds, '2026-01-02T00:00:00.000Z')).toEqual({
      status: 'completed', autoApproveJobId: 'timer-1',
    });
    expect(store.has(REDIS_KEY_PENDING_POST)).toBe(false);
    expect(store.has(REDIS_KEY_PENDING_POST_JOB_ID)).toBe(false);
    expect(JSON.parse(registry.get(pending.videoId)!) as VideoRecord).toMatchObject({
      status: 'posted', postId: 't3_post', commentId: 't1_comment',
    });
  });
});

describe('legacy auto-approval migration', () => {
  it('replaces only the current pending post’s targetless timer with a target-bound job', async () => {
    const pending = pendingPost();
    const { redis, store } = createAtomicFakeContext({
      [REDIS_KEY_PENDING_POST]: JSON.stringify(pending),
      [REDIS_KEY_PENDING_POST_JOB_ID]: 'legacy-timer',
    });
    const cancelled: string[] = [];
    const scheduled: Array<{ name: string; runAt: Date; data: { videoId: string; generatedAt: string } }> = [];
    const legacyRunAt = new Date(Date.now() + 60_000);
    const scheduler = {
      listJobs: async () => [
        { id: 'legacy-timer', name: 'post_pending_episode', runAt: legacyRunAt },
        { id: 'unrelated-timer', name: 'post_pending_episode', runAt: legacyRunAt },
      ],
      runJob: async (job: { name: string; runAt: Date; data: { videoId: string; generatedAt: string } }) => {
        scheduled.push(job);
        return 'target-bound-timer';
      },
      cancelJob: async (id: string) => { cancelled.push(id); },
    };

    await migrateLegacyAutoApproveJob({ redis, scheduler });

    expect(scheduled).toEqual([{
      name: 'post_pending_episode',
      runAt: legacyRunAt,
      data: targetOf(pending),
    }]);
    expect(store.get(REDIS_KEY_PENDING_POST_JOB_ID)).toBe('target-bound-timer');
    expect(cancelled).toEqual(['legacy-timer']);
  });
});

describe('review resolution', () => {
  it('rejects discard and reject once Reddit creation has started', async () => {
    const pending = pendingPost({ postId: 't3_live' });
    const { redis } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(pending) });

    expect(await resolvePendingPost(redis, targetOf(pending), 'discard')).toEqual({ status: 'partially-published' });
    expect(await resolvePendingPost(redis, targetOf(pending), 'reject')).toEqual({ status: 'partially-published' });
    expect(await getPendingPost(redis)).toEqual(pending);
  });

  it('transitions the registry and removes the exact queue record in one transaction', async () => {
    const pending = pendingPost();
    const { redis, registry, store } = createAtomicFakeContext({
      [REDIS_KEY_PENDING_POST]: JSON.stringify(pending),
      [REDIS_KEY_PENDING_POST_JOB_ID]: 'timer-1',
    }, {
      [pending.videoId]: JSON.stringify({ title: pending.videoTitle, status: 'pending', processedAt: pending.generatedAt }),
    });

    expect(await resolvePendingPost(redis, targetOf(pending), 'reject')).toEqual({
      status: 'resolved', pending, autoApproveJobId: 'timer-1',
    });
    expect(store.has(REDIS_KEY_PENDING_POST)).toBe(false);
    expect(store.has(REDIS_KEY_PENDING_POST_JOB_ID)).toBe(false);
    expect(JSON.parse(registry.get(pending.videoId)!) as VideoRecord).toMatchObject({ status: 'rejected' });
  });

  it('makes an existing link-post title immutable while still accepting discussion edits', async () => {
    const pending = pendingPost({ postId: 't3_live', commentId: 't1_discussion' });
    const { redis } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(pending) });

    expect(await updatePendingPostForReview(redis, targetOf(pending), { title: 'Different title' })).toEqual({
      status: 'title-immutable',
    });
    expect(await updatePendingPostForReview(redis, targetOf(pending), { body: 'Edited discussion' })).toMatchObject({
      status: 'updated', pending: { title: pending.title, body: 'Edited discussion' },
    });
  });
});

describe('review form identity', () => {
  it('binds the form to the pending video and generation', () => {
    const form = buildReviewPendingPostForm({
      title: 't', body: 'b', videoTitle: 'v', videoId: 'video-a', generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const target = form.fields.find((field) => 'name' in field && field.name === 'pendingPostTarget');
    expect(target).toMatchObject({ type: 'select', required: true });
    if (!target || !('defaultValue' in target)) throw new Error('expected pending post target');
    expect(parsePendingPostTarget({ pendingPostTarget: target.defaultValue })).toEqual({
      videoId: 'video-a', generatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('disables title edits and destructive actions after a link post exists', () => {
    const form = buildReviewPendingPostForm({
      title: 't', body: 'b', videoTitle: 'v', videoId: 'video-a', generatedAt: '2026-01-01T00:00:00.000Z', postId: 't3_live',
    });
    const title = form.fields.find((field) => 'name' in field && field.name === 'postTitle');
    const action = form.fields.find((field) => 'name' in field && field.name === 'action');
    expect(title).toMatchObject({ disabled: true });
    expect(action).toMatchObject({ options: [{ value: 'publish' }] });
  });
});

describe('parseReviewAction', () => {
  it('defaults to publish for malformed values', () => {
    expect(parseReviewAction({ action: ['nonsense'] })).toBe('publish');
  });
});
