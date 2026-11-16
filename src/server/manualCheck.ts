import { randomUUID } from 'node:crypto';

import type { Form } from '@devvit/web/shared';

export const CHECK_TRIGGERED_BY_KEY = 'check_triggered_by';

/** Installation-wide lock held while one checker job selects and processes a video. */
export const CHECK_CLAIM_KEY = 'check_new_episodes_claim';
const CHECK_CLAIM_TTL_MS = 5 * 60 * 1000;

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

type CheckerClaimRedis = {
  set: (key: string, value: string, options?: { expiration?: Date; nx?: boolean }) => Promise<unknown>;
  get: (key: string) => Promise<string | undefined>;
  watch: (...keys: string[]) => Promise<{
    multi: () => Promise<unknown>;
    del: (key: string) => Promise<unknown>;
    exec: () => Promise<unknown[]>;
    unwatch: () => Promise<unknown>;
  }>;
};

/** Acquire the checker claim atomically; null means another check is still running. */
export async function claimChecker(redis: CheckerClaimRedis): Promise<string | null> {
  const claimId = randomUUID();
  const acquired = await redis.set(CHECK_CLAIM_KEY, claimId, {
    expiration: new Date(Date.now() + CHECK_CLAIM_TTL_MS),
    nx: true,
  });
  return acquired ? claimId : null;
}

/** Release only this invocation's claim, never a later claim acquired after expiry. */
export async function releaseCheckerClaim(redis: CheckerClaimRedis, claimId: string): Promise<void> {
  try {
    const transaction = await redis.watch(CHECK_CLAIM_KEY);
    if (await redis.get(CHECK_CLAIM_KEY) !== claimId) {
      await transaction.unwatch();
      return;
    }
    await transaction.multi();
    await transaction.del(CHECK_CLAIM_KEY);
    await transaction.exec();
  } catch (err) {
    console.error(`[bot] Failed to release checker claim: ${err}`);
  }
}

type ManualCheckClients = {
  reddit: { getCurrentUsername(): Promise<string | undefined> };
  redis: { set(key: string, value: string): Promise<unknown> };
  scheduler: {
    runJob(job: {
      name: 'check_new_episodes';
      runAt: Date;
      data: { manual: true; forceRepost: boolean; triggeredBy?: string };
    }): Promise<unknown>;
  };
};

export async function scheduleManualCheck(
  { reddit, redis, scheduler }: ManualCheckClients,
  forceRepost: boolean,
): Promise<void> {
  const username = await reddit.getCurrentUsername();
  if (username) {
    // Kept as a fallback for jobs scheduled by older app versions.
    await redis.set(CHECK_TRIGGERED_BY_KEY, username);
  }
  await scheduler.runJob({
    name: 'check_new_episodes',
    runAt: new Date(),
    data: {
      manual: true,
      forceRepost,
      ...(username ? { triggeredBy: username } : {}),
    },
  });
}
