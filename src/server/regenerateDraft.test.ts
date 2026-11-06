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
  postId: 't3_abc',
  videoId: 'vid1',
  commentId: 't1_xyz',
  systemPrompt: 'You are a helpful bot.',
  model: 'gemini-flash-latest',
  triggeredBy: 'some-mod',
  ...overrides,
});

describe('saveRegenerateDraft / loadRegenerateDraft', () => {
  it('round-trips a draft for a given user', async () => {
    const redis = createFakeRedis();
    await saveRegenerateDraft(redis, 't2_user1', draft());
    expect(await loadRegenerateDraft(redis, 't2_user1')).toEqual(draft());
  });

  it('keys drafts separately per user', async () => {
    const redis = createFakeRedis();
    await saveRegenerateDraft(redis, 't2_user1', draft({ model: 'model-a' }));
    await saveRegenerateDraft(redis, 't2_user2', draft({ model: 'model-b' }));
    expect((await loadRegenerateDraft(redis, 't2_user1'))?.model).toBe('model-a');
    expect((await loadRegenerateDraft(redis, 't2_user2'))?.model).toBe('model-b');
  });

  it('sets a 1 hour expiration on save', async () => {
    const redis = createFakeRedis();
    const before = Date.now();
    await saveRegenerateDraft(redis, 't2_user1', draft());
    const expiration = redis.expirations.get(draftKey('t2_user1'));
    expect(expiration).toBeDefined();
    const ttlMs = (expiration as Date).getTime() - before;
    expect(ttlMs).toBeGreaterThan(59 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('returns null when no draft exists for the user', async () => {
    const redis = createFakeRedis();
    expect(await loadRegenerateDraft(redis, 'never-saved')).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', async () => {
    const redis = createFakeRedis();
    await redis.set(draftKey('t2_user1'), 'not valid json');
    expect(await loadRegenerateDraft(redis, 't2_user1')).toBeNull();
  });
});

describe('clearRegenerateDraft', () => {
  it('removes a saved draft', async () => {
    const redis = createFakeRedis();
    await saveRegenerateDraft(redis, 't2_user1', draft());
    await clearRegenerateDraft(redis, 't2_user1');
    expect(await loadRegenerateDraft(redis, 't2_user1')).toBeNull();
  });
});
