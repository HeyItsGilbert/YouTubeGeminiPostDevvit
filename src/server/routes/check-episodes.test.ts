import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const registry = new Map<string, string>();
const versions = new Map<string, number>();
const bump = (key: string) => versions.set(key, (versions.get(key) ?? 0) + 1);
const scheduler = {
  cancelJob: vi.fn(),
  runJob: vi.fn(),
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
  hGetAll: async (): Promise<Record<string, string>> => Object.fromEntries(registry),
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
const settings = {
  get: vi.fn(),
};
const reddit = {
  sendPrivateMessage: vi.fn(),
  getSubredditByName: vi.fn(),
  modMail: { createModInboxConversation: vi.fn() },
};
const fetchPlaylistVideos = vi.fn();
const generateEpisodePost = vi.fn();

vi.mock('@devvit/web/server', () => ({
  context: { subredditName: 'test' },
  reddit,
  redis,
  scheduler,
  settings,
}));
vi.mock('../episodeChecker.js', () => ({ fetchPlaylistVideos }));
vi.mock('../llmClient.js', () => ({ generateEpisodePost }));
// The route is loaded after network collaborators are mocked.
const { checkEpisodes } = await import('./check-episodes.js');

async function runCheck() {
  return checkEpisodes.request('/check-new-episodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  });
}

describe('check_new_episodes approval queue', () => {
  beforeEach(() => {
    store.clear();
    registry.clear();
    versions.clear();
    scheduler.cancelJob.mockReset();
    scheduler.runJob.mockReset().mockResolvedValue('auto-approve-1');
    reddit.sendPrivateMessage.mockReset().mockResolvedValue(undefined);
    fetchPlaylistVideos.mockReset().mockResolvedValue([{
      guid: 'video-1',
      title: 'Video 1',
      description: 'Description',
      pubDate: '2026-01-01T00:00:00.000Z',
      link: 'https://example.test/video-1',
    }]);
    generateEpisodePost.mockReset().mockResolvedValue({ title: 'Generated title', body: 'Generated body' });
    settings.get.mockReset().mockImplementation(async (key: string) => ({
      youtubePlaylistId: 'PL_test',
      excludeTitleKeywords: '',
      systemPrompt: 'Prompt',
      botFlairEmoji: '',
      botFlairText: '',
      prependText: '',
      appendText: '',
      flairName: '',
      requireModApproval: true,
      autoApproveWindowMinutes: 5,
      notificationMods: 'mod',
    })[key]);
    store.set('google_api_key', 'key');
  });

  it('binds its auto-approve job to the queued video and generation timestamp', async () => {
    const response = await runCheck();
    const queued = JSON.parse(store.get('pending_post')!);

    expect(response.status).toBe(200);
    expect(scheduler.runJob).toHaveBeenCalledWith(expect.objectContaining({
      name: 'post_pending_episode',
      data: { videoId: queued.videoId, generatedAt: queued.generatedAt },
    }));
    expect(store.get('pending_post_job_id')).toBe('auto-approve-1');
  });
});
