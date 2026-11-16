import { describe, expect, it } from 'vitest';
import {
  REDIS_KEY_PENDING_POST,
  REDIS_KEY_PENDING_POST_JOB_ID,
  buildReviewPendingPostForm,
  cancelAutoApproveJob,
  claimPendingPost,
  clearPendingPost,
  getPendingPost,
  parsePendingPostTarget,
  parseReviewAction,
  releasePendingPostClaim,
  savePendingPostPublication,
  type PendingPost,
} from './pendingPost.js';

/** Map-backed fake Redis + array-backed fake scheduler — no Devvit SDK mocking. */
function createFakeContext(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const cancelledIds: string[] = [];

  const redis = {
    get: async (key: string): Promise<string | undefined> => store.get(key),
    set: async (key: string, value: string): Promise<void> => {
      store.set(key, value);
    },
    del: async (key: string): Promise<void> => {
      store.delete(key);
    },
  };

  const scheduler = {
    cancelJob: async (jobId: string): Promise<void> => {
      cancelledIds.push(jobId);
    },
  };

  return { redis, scheduler, store, cancelledIds };
}

function createAtomicFakeContext(initial: Record<string, string> = {}) {
  const { redis, store } = createFakeContext(initial);
  const atomicRedis = {
    ...redis,
    watch: async (...keys: string[]) => {
      const watched = new Map(keys.map((key) => [key, store.get(key)]));
      const commands: (() => void)[] = [];
      return {
        multi: async () => {},
        set: async (key: string, value: string) => commands.push(() => store.set(key, value)),
        del: async (...keysToDelete: string[]) => commands.push(() => keysToDelete.forEach((key) => store.delete(key))),
        exec: async () => {
          if ([...watched].some(([key, value]) => store.get(key) !== value)) return [];
          commands.forEach((command) => command());
          return commands.map(() => 'OK');
        },
        unwatch: async () => {},
      };
    },
  };
  return { redis: atomicRedis, store };
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

describe('getPendingPost', () => {
  it('returns null when nothing is pending', async () => {
    const { redis } = createFakeContext();
    expect(await getPendingPost(redis)).toBeNull();
  });

  it('returns the parsed pending post when one is stored', async () => {
    const pending = pendingPost();
    const { redis } = createFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(pending) });
    expect(await getPendingPost(redis)).toEqual(pending);
  });
});

describe('cancelAutoApproveJob', () => {
  it('cancels the scheduled job and clears the job id key', async () => {
    const { redis, scheduler, store, cancelledIds } = createFakeContext({
      [REDIS_KEY_PENDING_POST_JOB_ID]: 'job-1',
    });
    await cancelAutoApproveJob(redis, scheduler);
    expect(cancelledIds).toEqual(['job-1']);
    expect(store.has(REDIS_KEY_PENDING_POST_JOB_ID)).toBe(false);
  });

  it('is a no-op when no auto-approve job is scheduled', async () => {
    const { redis, scheduler, cancelledIds } = createFakeContext();
    await cancelAutoApproveJob(redis, scheduler);
    expect(cancelledIds).toEqual([]);
  });
});

describe('clearPendingPost', () => {
  it('returns null when nothing is pending', async () => {
    const { redis, scheduler } = createFakeContext();
    expect(await clearPendingPost(redis, scheduler)).toBeNull();
  });

  it('removes the pending post, cancels the auto-approve job, and returns the removed post', async () => {
    const pending = pendingPost();
    const { redis, scheduler, store, cancelledIds } = createFakeContext({
      [REDIS_KEY_PENDING_POST]: JSON.stringify(pending),
      [REDIS_KEY_PENDING_POST_JOB_ID]: 'job-2',
    });
    const removed = await clearPendingPost(redis, scheduler);
    expect(removed).toEqual(pending);
    expect(store.has(REDIS_KEY_PENDING_POST)).toBe(false);
    expect(store.has(REDIS_KEY_PENDING_POST_JOB_ID)).toBe(false);
    expect(cancelledIds).toEqual(['job-2']);
  });
});

describe('parseReviewAction', () => {
  it('defaults to publish when action is missing', () => {
    expect(parseReviewAction({})).toBe('publish');
  });

  it('reads discard from a select field value array', () => {
    expect(parseReviewAction({ action: ['discard'] })).toBe('discard');
  });

  it('reads reject from a select field value array', () => {
    expect(parseReviewAction({ action: ['reject'] })).toBe('reject');
  });

  it('falls back to publish for an unrecognized value', () => {
    expect(parseReviewAction({ action: ['nonsense'] })).toBe('publish');
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

  it('rejects a malformed form target', () => {
    expect(parsePendingPostTarget({ pendingPostTarget: ['not a target'] })).toBeNull();
  });
});

describe('pending publication claim', () => {
  it('allows only one publisher and keeps persisted Reddit IDs for a retry', async () => {
    const pending = pendingPost();
    const { redis, store } = createAtomicFakeContext({ [REDIS_KEY_PENDING_POST]: JSON.stringify(pending) });

    const first = await claimPendingPost(redis);
    const second = await claimPendingPost(redis);
    expect(first.status).toBe('claimed');
    expect(second.status).toBe('busy');
    if (!first.pending) throw new Error('expected claimed pending post');

    await savePendingPostPublication(redis, first.pending, { postId: 't3_post', commentId: 't1_comment' });
    await releasePendingPostClaim(redis, first.pending);

    expect(await getPendingPost(redis)).toMatchObject({
      postId: 't3_post', commentId: 't1_comment', publishing: false,
    });
    expect(store.has(REDIS_KEY_PENDING_POST)).toBe(true);
  });
});

describe('buildReviewPendingPostForm', () => {
  it('pre-fills the title and body fields from the pending post', () => {
    const form = buildReviewPendingPostForm({
      title: 'My Title',
      body: 'My Body',
      videoTitle: 'My Video',
      videoId: 'video-id',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const postTitle = form.fields.find((f) => 'name' in f && f.name === 'postTitle');
    const postBody = form.fields.find((f) => 'name' in f && f.name === 'postBody');
    expect(postTitle).toMatchObject({ defaultValue: 'My Title', required: true });
    expect(postBody).toMatchObject({ defaultValue: 'My Body', required: true });
  });

  it('offers Publish, Discard, and Reject as the action options, defaulting to Publish', () => {
    const form = buildReviewPendingPostForm({
      title: 't', body: 'b', videoTitle: 'v', videoId: 'video-id', generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const action = form.fields.find((f) => 'name' in f && f.name === 'action');
    expect(action).toMatchObject({ type: 'select', defaultValue: ['publish'], required: true });
    if (!action || !('options' in action)) {
      throw new Error('expected the action field to have options');
    }
    expect(action.options.map((o) => o.value)).toEqual(['publish', 'discard', 'reject']);
  });

  it('warns about the ~10-minute submission window', () => {
    const form = buildReviewPendingPostForm({
      title: 't', body: 'b', videoTitle: 'v', videoId: 'video-id', generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(form.description).toMatch(/10.minute/i);
  });

  it('includes the video title for context', () => {
    const form = buildReviewPendingPostForm({
      title: 't', body: 'b', videoTitle: 'My Video', videoId: 'video-id', generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(form.description).toContain('My Video');
  });
});
