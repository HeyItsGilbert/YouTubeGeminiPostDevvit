import { describe, expect, it } from 'vitest';
import { sendFailureNotification } from './notifications.js';

type SentMessage = { to: string; subject: string; text: string };

function createFakeReddit(failFor: Set<string> = new Set()) {
  const sent: SentMessage[] = [];
  const reddit = {
    sendPrivateMessage: async (message: SentMessage): Promise<void> => {
      if (failFor.has(message.to)) {
        throw new Error(`cannot PM ${message.to}`);
      }
      sent.push(message);
    },
  };
  return { reddit, sent };
}

describe('sendFailureNotification', () => {
  it('PMs every configured notificationMods recipient', async () => {
    const { reddit, sent } = createFakeReddit();
    await sendFailureNotification(reddit, ['alice', 'bob'], 'carol', 'Subject', 'Body');
    expect(sent).toEqual([
      { to: 'alice', subject: 'Subject', text: 'Body' },
      { to: 'bob', subject: 'Subject', text: 'Body' },
    ]);
  });

  it('falls back to the triggering mod when no notificationMods are configured', async () => {
    const { reddit, sent } = createFakeReddit();
    await sendFailureNotification(reddit, [], 'carol', 'Subject', 'Body');
    expect(sent).toEqual([{ to: 'carol', subject: 'Subject', text: 'Body' }]);
  });

  it('sends nothing when there are no notificationMods and no fallback recipient', async () => {
    const { reddit, sent } = createFakeReddit();
    await sendFailureNotification(reddit, [], undefined, 'Subject', 'Body');
    expect(sent).toEqual([]);
  });

  it('keeps notifying the remaining recipients when one PM fails', async () => {
    const { reddit, sent } = createFakeReddit(new Set(['alice']));
    await expect(
      sendFailureNotification(reddit, ['alice', 'bob'], null, 'Subject', 'Body'),
    ).resolves.toBeUndefined();
    expect(sent).toEqual([{ to: 'bob', subject: 'Subject', text: 'Body' }]);
  });
});
