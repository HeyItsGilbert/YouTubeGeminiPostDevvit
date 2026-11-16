import { describe, expect, it } from 'vitest';
import { clearRegenerateDraft, draftKey, loadRegenerateDraft, saveRegenerateDraft, type RegenerateDraft } from './regenerateDraft.js';

/** Map-backed fake Redis string store with TTL recording — only the commands regenerateDraft.ts uses. */
function createFakeRedis() {
  const store = new Map<string, string>();
  const expirations = new Map<string, Date>();
  return {
    store,
    expirations,
    async set(key: string, value: string, options?: { expiration?: Date }): Promise<void> {
      store.set(key, value);
      if (options?.expiration) expirations.set(key, options.expiration);
    },
    async get(key: string): Promise<string | undefined> {
      return store.get(key);
    },
    async del(key: string): Promise<void> {
      store.delete(key);
      expirations.delete(key);
    },
  };
}

const draft = (overrides: Partial<RegenerateDraft> = {}): RegenerateDraft => ({
  requestId: 'request-a',
  postId: 't3_abc',
  videoId: 'vid1',
  commentId: 't1_xyz',
  systemPrompt: 'You are a helpful bot.',
  model: 'gemini-flash-latest',
  triggeredBy: 'some-mod',
  ...overrides,
});

describe('saveRegenerateDraft / loadRegenerateDraft', () => {
  it('round-trips a draft for a given user and request', async () => {
    const redis = createFakeRedis();
    await saveRegenerateDraft(redis, 't2_user1', 'request-a', draft());
    expect(await loadRegenerateDraft(redis, 't2_user1', 'request-a')).toEqual(draft());
  });

  it('keeps concurrent requests from the same moderator separate', async () => {
    const redis = createFakeRedis();
    await saveRegenerateDraft(redis, 't2_user1', 'request-a', draft({ requestId: 'request-a', commentId: 't1_a' }));
    await saveRegenerateDraft(redis, 't2_user1', 'request-b', draft({ requestId: 'request-b', commentId: 't1_b' }));
    expect((await loadRegenerateDraft(redis, 't2_user1', 'request-a'))?.commentId).toBe('t1_a');
    expect((await loadRegenerateDraft(redis, 't2_user1', 'request-b'))?.commentId).toBe('t1_b');
  });

  it('sets a 1 hour expiration on save', async () => {
    const redis = createFakeRedis();
    const before = Date.now();
    await saveRegenerateDraft(redis, 't2_user1', 'request-a', draft());
    const expiration = redis.expirations.get(draftKey('t2_user1', 'request-a'));
    expect(expiration).toBeDefined();
    const ttlMs = (expiration as Date).getTime() - before;
    expect(ttlMs).toBeGreaterThan(59 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('returns null when no draft exists for the user and request', async () => {
    const redis = createFakeRedis();
    expect(await loadRegenerateDraft(redis, 'never-saved', 'request-a')).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', async () => {
    const redis = createFakeRedis();
    await redis.set(draftKey('t2_user1', 'request-a'), 'not valid json');
    expect(await loadRegenerateDraft(redis, 't2_user1', 'request-a')).toBeNull();
  });
});

describe('clearRegenerateDraft', () => {
  it('removes only the matching saved request', async () => {
    const redis = createFakeRedis();
    await saveRegenerateDraft(redis, 't2_user1', 'request-a', draft({ requestId: 'request-a' }));
    await saveRegenerateDraft(redis, 't2_user1', 'request-b', draft({ requestId: 'request-b' }));
    await clearRegenerateDraft(redis, 't2_user1', 'request-a');
    expect(await loadRegenerateDraft(redis, 't2_user1', 'request-a')).toBeNull();
    expect(await loadRegenerateDraft(redis, 't2_user1', 'request-b')).toMatchObject({ requestId: 'request-b' });
  });
});
