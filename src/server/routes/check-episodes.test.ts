import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
const sentMessages: { to: string; subject: string; text: string }[] = [];
const context = { subredditName: 'testsub' };
const scheduler = { runJob: vi.fn() };

const redis = {
  get: async (key: string) => values.get(key),
  set: async (key: string, value: string, options?: { nx?: boolean }) => {
    if (options?.nx && values.has(key)) return undefined;
    values.set(key, value);
    return 'OK';
  },
  del: async (...keys: string[]) => keys.forEach((key) => values.delete(key)),
  watch: async (...keys: string[]) => {
    const watched = new Map(keys.map((key) => [key, values.get(key)]));
    let deleteKey: string | undefined;
    return {
      multi: async () => {},
      del: async (key: string) => { deleteKey = key; },
      exec: async () => {
        if ([...watched].some(([key, value]) => values.get(key) !== value)) return [];
        if (deleteKey) values.delete(deleteKey);
        return ['OK'];
      },
      unwatch: async () => {},
    };
  },
};

const settings = {
  get: async <T>(key: string): Promise<T | undefined> => ({
    youtubePlaylistId: 'PL_test',
    excludeTitleKeywords: '',
    systemPrompt: 'Prompt',
    botFlairEmoji: '',
    botFlairText: '',
    prependText: '',
    appendText: '',
    flairName: '',
    requireModApproval: true,
    autoApproveWindowMinutes: 0,
    notificationMods: 'other-mod',
  }[key] as T | undefined),
};

const reddit = {
  sendPrivateMessage: async (message: { to: string; subject: string; text: string }) => {
    sentMessages.push(message);
  },
  getSubredditByName: vi.fn(),
  modMail: { createModInboxConversation: vi.fn() },
};

vi.mock('@devvit/web/server', () => ({ context, reddit, redis, scheduler, settings }));
vi.mock('../episodeChecker.js', () => ({
  fetchPlaylistVideos: vi.fn().mockResolvedValue([{ guid: 'video-1', title: 'Video one', description: '', pubDate: '', link: 'https://youtu.be/video-1' }]),
}));
vi.mock('../llmClient.js', () => ({ generateEpisodePost: vi.fn().mockResolvedValue({ title: 'Discussion', body: 'Body' }) }));
vi.mock('../configureBot.js', () => ({
  REDIS_KEY_GOOGLE_API_KEY: 'google_api_key',
  getGeminiChoice: vi.fn().mockResolvedValue({ model: 'gemini-flash-latest', thinkingLevel: undefined }),
}));
vi.mock('../videoRegistry.js', () => ({
  getAllVideoRecords: vi.fn().mockResolvedValue({}),
  setVideoRecord: vi.fn().mockResolvedValue(true),
}));
vi.mock('../postManager.js', () => ({
  createEpisodePost: vi.fn(), applyBotFlair: vi.fn(), applyFlair: vi.fn(), managePins: vi.fn(),
}));

const { checkEpisodes } = await import('./check-episodes.js');

describe('check_new_episodes approval notifications', () => {
  beforeEach(() => {
    values.clear();
    values.set('google_api_key', 'key');
    sentMessages.length = 0;
  });

  it('notifies the manual caller when configured approval recipients exclude them', async () => {
    await checkEpisodes.request('/check-new-episodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { manual: true, forceRepost: false, triggeredBy: 'calling-mod' } }),
    });

    expect(sentMessages.map((message) => message.to)).toEqual(['other-mod', 'calling-mod']);
  });
});
