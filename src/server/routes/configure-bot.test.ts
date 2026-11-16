import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const context = { userId: 't2_moderator-a' };
let beforeNextExec: (() => void) | undefined;

type QueuedCommand = () => void;

function redisValue(key: string): string | undefined {
  return store.get(key);
}

const redis = {
  get: async (key: string) => redisValue(key),
  set: async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  },
  del: async (...keys: string[]) => {
    keys.forEach((key) => store.delete(key));
  },
  watch: async (...keys: string[]) => {
    const watched = new Map(keys.map((key) => [key, redisValue(key)]));
    const commands: QueuedCommand[] = [];

    return {
      multi: async () => {},
      set: async (key: string, value: string) => {
        commands.push(() => store.set(key, value));
      },
      del: async (...commandKeys: string[]) => {
        commands.push(() => commandKeys.forEach((key) => store.delete(key)));
      },
      exec: async () => {
        const mutation = beforeNextExec;
        beforeNextExec = undefined;
        mutation?.();
        if ([...watched].some(([key, value]) => redisValue(key) !== value)) {
          return [];
        }
        commands.forEach((command) => command());
        return commands.map(() => 'OK');
      },
      unwatch: async () => {},
    };
  },
};

vi.mock('@devvit/web/server', () => ({
  context,
  redis,
  scheduler: {},
}));

vi.mock('../checkerSchedule.js', () => ({
  ensureCheckerScheduled: vi.fn(),
}));

const { configureBot } = await import('./configure-bot.js');

async function submit(path: string, body: unknown) {
  return configureBot.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function submittedThinkingLevel(userId: string, level: string): string[] {
  const draft = JSON.parse(store.get(`configure_bot_draft:${userId}`)!) as { revision: string };
  return [`${draft.revision}:${level}`];
}

describe('Configure bot thinking-level form', () => {
  beforeEach(() => {
    store.clear();
    beforeNextExec = undefined;
    context.userId = 't2_moderator-a';
  });

  it('does not let an older form overwrite a newer configuration save', async () => {
    await submit('/form/configure-bot', {
      pinSlot: ['1'],
      geminiModel: ['gemini-pro-latest'],
      customizeThinking: true,
    });

    const selection = submittedThinkingLevel('t2_moderator-a', 'high');

    context.userId = 't2_moderator-b';
    await submit('/form/configure-bot', {
      pinSlot: ['1'],
      geminiModel: ['gemini-flash-latest'],
      customizeThinking: false,
    });

    context.userId = 't2_moderator-a';
    const response = await submit('/form/configure-bot-thinking-level', { thinkingLevel: selection });

    expect(await response.json()).toEqual({
      showToast: 'Configuration changed while this form was open. Open "Configure bot" and try again.',
    });
    expect(store.get('gemini_thinking_level')).toBeUndefined();
  });

  it('aborts a save when shared model or thinking state changes after it is read', async () => {
    store.set('gemini_model', 'gemini-pro-latest');
    store.set('gemini_thinking_level', 'high');
    store.set('configure_bot_revision', 'revision-a');
    beforeNextExec = () => {
      store.set('gemini_model', 'gemini-flash-latest');
      store.set('gemini_thinking_level', 'low');
      store.set('configure_bot_revision', 'revision-b');
    };

    const response = await submit('/form/configure-bot', {
      pinSlot: ['1'],
      geminiModel: ['gemini-pro-latest'],
      customizeThinking: true,
    });

    expect(await response.json()).toEqual({
      showToast: 'Configuration changed while this form was submitted. Open "Configure bot" and try again.',
    });
    expect(store.get('gemini_model')).toBe('gemini-flash-latest');
    expect(store.get('gemini_thinking_level')).toBe('low');
  });

  it('does not let an older form delete a newer draft from the same moderator', async () => {
    await submit('/form/configure-bot', {
      pinSlot: ['1'],
      geminiModel: ['gemini-pro-latest'],
      customizeThinking: true,
    });
    const olderSelection = submittedThinkingLevel('t2_moderator-a', 'high');

    await submit('/form/configure-bot', {
      pinSlot: ['1'],
      geminiModel: ['gemini-flash-latest'],
      customizeThinking: true,
    });
    const newerDraft = store.get('configure_bot_draft:t2_moderator-a');

    const response = await submit('/form/configure-bot-thinking-level', { thinkingLevel: olderSelection });

    expect(await response.json()).toEqual({
      showToast: 'Configuration changed while this form was open. Open "Configure bot" and try again.',
    });
    expect(store.get('configure_bot_draft:t2_moderator-a')).toBe(newerDraft);
    expect(store.get('gemini_model')).toBe('gemini-flash-latest');
  });
});
