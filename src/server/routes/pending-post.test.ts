import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const registry = new Map<string, string>();
const versions = new Map<string, number>();
const bump = (key: string) => versions.set(key, (versions.get(key) ?? 0) + 1);
const scheduler = {
  cancelJob: vi.fn(),
};
const reddit = {};
const settings = {
  get: vi.fn(),
};
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
  hGet: async (_key: string, field: string): Promise<string | undefined> => registry.get(field),
  hSet: async (key: string, values: Record<string, string>): Promise<void> => {
    Object.entries(values).forEach(([field, value]) => registry.set(field, value));
    bump(key);
  },
  hDel: async (key: string, fields: string[]): Promise<void> => {
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
        Object.entries(values).forEach(([field, value]) => registry.set(field, value));
        bump(key);
      }),
      hDel: async (key: string, fields: string[]) => commands.push(() => {
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
const postManager = {
  applyBotFlair: vi.fn(),
  applyFlair: vi.fn(),
  createEpisodeDiscussionComment: vi.fn(),
  createEpisodeLinkPost: vi.fn(),
  distinguishEpisodeDiscussionComment: vi.fn(),
  managePins: vi.fn(),
  updateEpisodePost: vi.fn(),
};
const notifications = {
  FAILURE_HELP: 'help',
  sendFailureNotification: vi.fn(),
  sendModInboxFailureNotification: vi.fn(),
};

vi.mock('@devvit/web/server', () => ({
  context: { subredditName: 'test' },
  reddit,
  redis,
  scheduler,
  settings,
}));
vi.mock('../postManager.js', () => postManager);
vi.mock('../notifications.js', () => notifications);
// The route is loaded after its module collaborators are mocked.
const { pendingPost } = await import('./pending-post.js');

const pending = (overrides: Record<string, unknown> = {}) => ({
  title: 'Generated title',
  body: 'Generated discussion',
  url: 'https://example.test/video',
  videoId: 'video-1',
  videoTitle: 'Video 1',
  generatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

async function runJob(data: Record<string, string> | undefined) {
  return pendingPost.request('/post-pending-episode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
}

describe('post_pending_episode', () => {
  beforeEach(() => {
    store.clear();
    registry.clear();
    versions.clear();
    scheduler.cancelJob.mockReset();
    settings.get.mockReset().mockResolvedValue('');
    Object.values(postManager).forEach((mock) => mock.mockReset().mockResolvedValue(undefined));
    Object.values(notifications).forEach((mock) => {
      if (typeof mock !== 'string') mock.mockReset().mockResolvedValue(undefined);
    });
  });

  it('does nothing when a delayed job targets a discarded Pending Post rather than its replacement', async () => {
    const replacement = pending({ videoId: 'video-2', generatedAt: '2026-01-02T00:00:00.000Z' });
    store.set('pending_post', JSON.stringify(replacement));

    const response = await runJob({ videoId: 'video-1', generatedAt: '2026-01-01T00:00:00.000Z' });

    expect(response.status).toBe(200);
    expect(postManager.createEpisodeLinkPost).not.toHaveBeenCalled();
    expect(JSON.parse(store.get('pending_post')!)).toEqual(replacement);
  });

  it('persists the link ID before a later creation failure and resumes without another link post', async () => {
    const queued = pending();
    store.set('pending_post', JSON.stringify(queued));
    store.set('pending_post_job_id', 'auto-approve-1');
    postManager.createEpisodeLinkPost.mockResolvedValue('t3_link');
    postManager.createEpisodeDiscussionComment.mockRejectedValueOnce(new Error('comment failed'));

    await runJob({ videoId: queued.videoId, generatedAt: queued.generatedAt });

    expect(JSON.parse(store.get('pending_post')!)).toMatchObject({ postId: 't3_link' });
    postManager.createEpisodeDiscussionComment.mockResolvedValue('t1_discussion');
    await runJob({ videoId: queued.videoId, generatedAt: queued.generatedAt });

    expect(postManager.createEpisodeLinkPost).toHaveBeenCalledTimes(1);
    expect(postManager.createEpisodeDiscussionComment).toHaveBeenCalledTimes(2);
    expect(store.has('pending_post')).toBe(false);
    expect(JSON.parse(registry.get(queued.videoId)!)).toMatchObject({
      status: 'posted', postId: 't3_link', commentId: 't1_discussion',
    });
    expect(scheduler.cancelJob).toHaveBeenCalledWith('auto-approve-1');
  });

  it('applies review edits to an existing Discussion Comment during reconciliation', async () => {
    const queued = pending({ postId: 't3_link', commentId: 't1_discussion', body: 'Moderator edit' });
    store.set('pending_post', JSON.stringify(queued));

    await runJob({ videoId: queued.videoId, generatedAt: queued.generatedAt });

    expect(postManager.createEpisodeLinkPost).not.toHaveBeenCalled();
    expect(postManager.createEpisodeDiscussionComment).not.toHaveBeenCalled();
    expect(postManager.updateEpisodePost).toHaveBeenCalledWith(reddit, 't1_discussion', 'Moderator edit');
  });

  it('notifies the moderator inbox when an unattended auto-approval fails', async () => {
    const queued = pending();
    store.set('pending_post', JSON.stringify(queued));
    postManager.createEpisodeLinkPost.mockRejectedValue(new Error('Reddit unavailable'));

    await runJob({ videoId: queued.videoId, generatedAt: queued.generatedAt });

    expect(notifications.sendFailureNotification).toHaveBeenCalled();
    expect(notifications.sendModInboxFailureNotification).toHaveBeenCalledWith(
      reddit,
      'test',
      'Episode post failed',
      expect.stringContaining('Reddit unavailable'),
    );
  });
});
