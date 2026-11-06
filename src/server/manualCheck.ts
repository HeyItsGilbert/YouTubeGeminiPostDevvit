import type { Form } from '@devvit/web/shared';

export const CHECK_TRIGGERED_BY_KEY = 'check_triggered_by';

export function isPlaytestInstall(appVersion: string): boolean {
  return appVersion.split('.').length > 3;
}

export function buildPlaytestCheckForm(): Form {
  return {
    title: 'Check for new videos',
    description: 'Testing Tools are available on this playtest install.',
    acceptLabel: 'Check',
    fields: [
      {
        type: 'boolean',
        name: 'forceRepost',
        label: 'Repost newest video even if already posted (always queues for review)',
        defaultValue: false,
      },
    ],
  };
}

type ManualCheckClients = {
  reddit: { getCurrentUsername(): Promise<string | undefined> };
  redis: { set(key: string, value: string): Promise<unknown> };
  scheduler: {
    runJob(job: {
      name: 'check_new_episodes';
      runAt: Date;
      data: { manual: true; forceRepost: boolean };
    }): Promise<unknown>;
  };
};

export async function scheduleManualCheck(
  { reddit, redis, scheduler }: ManualCheckClients,
  forceRepost: boolean,
): Promise<void> {
  const username = await reddit.getCurrentUsername();
  if (username) {
    await redis.set(CHECK_TRIGGERED_BY_KEY, username);
  }
  await scheduler.runJob({
    name: 'check_new_episodes',
    runAt: new Date(),
    data: { manual: true, forceRepost },
  });
}
