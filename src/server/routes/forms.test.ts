import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const registry = new Map<string, string>();
const scheduler = {
  cancelJob: vi.fn(),
  runJob: vi.fn(),
};

const reddit = {
  getCurrentUsername: vi.fn(),
};
const redis = {
  get: async (key: string) => store.get(key),
  set: async (key: string, value: string) => {
    store.set(key, value);
  },
  del: async (...keys: string[]) => {
    keys.forEach((key) => store.delete(key));
  },
  hGet: async (_key: string, field: string) => registry.get(field),
  hSet: async (_key: string, values: Record<string, string>) => {
    Object.entries(values).forEach(([field, value]) => registry.set(field, value));
  },
  hDel: async (_key: string, fields: string[]) => {
    fields.forEach((field) => registry.delete(field));
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
      hSet: async (_key: string, values: Record<string, string>) => commands.push(() => {
        Object.entries(values).forEach(([field, value]) => registry.set(field, value));
      }),
      hDel: async (_key: string, fields: string[]) => commands.push(() => {
        fields.forEach((field) => registry.delete(field));
      }),
    };
  },
};

vi.mock('@devvit/web/server', () => ({
  reddit,
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
    registry.clear();
    scheduler.cancelJob.mockClear();
    scheduler.runJob.mockClear();
    reddit.getCurrentUsername.mockReset().mockResolvedValue(undefined);
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

  it('schedules Publish with the reviewed Pending Post identity', async () => {
    const queued = {
      title: 'Video', body: 'Body', url: 'https://example.test/video', videoId: 'video-1',
      videoTitle: 'Video', generatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.set('pending_post', JSON.stringify(queued));

    const response = await submit({
      action: ['publish'],
      pendingPostTarget: [JSON.stringify({ videoId: queued.videoId, generatedAt: queued.generatedAt })],
      postTitle: queued.title,
      postBody: 'Moderator edit',
    });

    expect(await response.json()).toEqual({ showToast: 'Publishing pending post...' });
    expect(scheduler.runJob).toHaveBeenCalledWith(expect.objectContaining({
      name: 'post_pending_episode',
      data: { videoId: queued.videoId, generatedAt: queued.generatedAt },
    }));
  });

  it('schedules the target-bound publisher before cancelling its fallback timer', async () => {
    const queued = {
      title: 'Video', body: 'Body', url: 'https://example.test/video', videoId: 'video-1',
      videoTitle: 'Video', generatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.set('pending_post', JSON.stringify(queued));
    store.set('pending_post_job_id', 'auto-approve-1');

    await submit({
      action: ['publish'],
      pendingPostTarget: [JSON.stringify({ videoId: queued.videoId, generatedAt: queued.generatedAt })],
      postTitle: queued.title,
      postBody: queued.body,
    });

    expect(scheduler.runJob).toHaveBeenCalled();
    expect(scheduler.cancelJob).toHaveBeenCalledWith('auto-approve-1');
    expect(scheduler.runJob.mock.invocationCallOrder[0]).toBeLessThan(scheduler.cancelJob.mock.invocationCallOrder[0]!);
  });

  it('keeps the fallback timer and gives an actionable retry toast when scheduling fails', async () => {
    const queued = {
      title: 'Video', body: 'Body', url: 'https://example.test/video', videoId: 'video-1',
      videoTitle: 'Video', generatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.set('pending_post', JSON.stringify(queued));
    store.set('pending_post_job_id', 'auto-approve-1');
    scheduler.runJob.mockRejectedValueOnce(new Error('scheduler unavailable'));

    const response = await submit({
      action: ['publish'],
      pendingPostTarget: [JSON.stringify({ videoId: queued.videoId, generatedAt: queued.generatedAt })],
      postTitle: queued.title,
      postBody: queued.body,
    });

    expect(await response.json()).toEqual({
      showToast: 'Could not schedule publication. The auto-approval timer is still active; try Publish again shortly.',
    });
    expect(store.get('pending_post_job_id')).toBe('auto-approve-1');
    expect(scheduler.cancelJob).not.toHaveBeenCalled();
  });

  it('keeps the fallback timer when the triggering moderator cannot be identified', async () => {
    const queued = {
      title: 'Video', body: 'Body', url: 'https://example.test/video', videoId: 'video-1',
      videoTitle: 'Video', generatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.set('pending_post', JSON.stringify(queued));
    store.set('pending_post_job_id', 'auto-approve-1');
    reddit.getCurrentUsername.mockRejectedValueOnce(new Error('Reddit unavailable'));

    const response = await submit({
      action: ['publish'],
      pendingPostTarget: [JSON.stringify({ videoId: queued.videoId, generatedAt: queued.generatedAt })],
      postTitle: queued.title,
      postBody: queued.body,
    });

    expect(await response.json()).toEqual({
      showToast: 'Could not schedule publication. The auto-approval timer is still active; try Publish again shortly.',
    });
    expect(scheduler.runJob).not.toHaveBeenCalled();
    expect(store.get('pending_post_job_id')).toBe('auto-approve-1');
  });

  it('requires reconciliation instead of discarding a partially published Pending Post', async () => {
    const queued = {
      title: 'Video', body: 'Body', url: 'https://example.test/video', videoId: 'video-1',
      videoTitle: 'Video', generatedAt: '2026-01-01T00:00:00.000Z', postId: 't3_live',
    };
    store.set('pending_post', JSON.stringify(queued));

    const response = await submit({
      action: ['discard'],
      pendingPostTarget: [JSON.stringify({ videoId: queued.videoId, generatedAt: queued.generatedAt })],
    });

    expect(await response.json()).toEqual({
      showToast: 'This post was partly published. Choose Publish to finish it; it cannot be discarded or rejected.',
    });
    expect(JSON.parse(store.get('pending_post')!)).toEqual(queued);
  });
});
