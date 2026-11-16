import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const scheduler = {
  cancelJob: vi.fn(),
  runJob: vi.fn(),
};

const redis = {
  get: async (key: string) => store.get(key),
  set: async (key: string, value: string) => {
    store.set(key, value);
  },
  del: async (...keys: string[]) => {
    keys.forEach((key) => store.delete(key));
  },
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

vi.mock('@devvit/web/server', () => ({
  reddit: { getCurrentUsername: vi.fn() },
  redis,
  scheduler,
}));
const { forms } = await import('./forms.js');

async function submit(body: unknown) {
  return forms.request('/review-pending-post-submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Review pending post form', () => {
  beforeEach(() => {
    store.clear();
    scheduler.cancelJob.mockClear();
    scheduler.runJob.mockClear();
  });

  it('does not discard a newer pending video from a stale review form', async () => {
    const newerPending = {
      title: 'New video', body: 'New body', url: 'https://example.test/new', videoId: 'new-video',
      videoTitle: 'New video', generatedAt: '2026-01-02T00:00:00.000Z',
    };
    store.set('pending_post', JSON.stringify(newerPending));

    const response = await submit({
      action: ['discard'],
      pendingPostTarget: [JSON.stringify({ videoId: 'old-video', generatedAt: '2026-01-01T00:00:00.000Z' })],
    });

    expect(await response.json()).toEqual({
      showToast: 'This review form is stale. Open "Review pending post" and try again.',
    });
    expect(JSON.parse(store.get('pending_post')!)).toEqual(newerPending);
  });
});
