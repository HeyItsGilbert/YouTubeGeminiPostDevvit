/**
 * Install/upgrade/activity triggers — keep the recurring `check_new_episodes`
 * job alive. See `../checkerSchedule.ts` for the reset/heal state machine.
 *
 * Named by Devvit primitive rather than by feature (unlike `routes/
 * check-episodes.ts` etc. — see docs/adr/0003): all four triggers exist
 * solely to keep the checker job alive, infrastructure for the whole app
 * rather than any one feature, so there is no feature module to fold them
 * into.
 *
 * Devvit cron jobs created dynamically in app code (as opposed to jobs
 * declared in devvit.json) are not guaranteed to survive every app version
 * deploy, and AppInstall only fires once on first install — so without the
 * AppUpgrade leg here, a mod updating the app version can silently lose the
 * recurring check_new_episodes job with no automatic recovery.
 *
 * AppInstall/AppUpgrade alone have left installs with no checker job and no
 * log line, so subreddit activity also re-verifies it (throttled to once per
 * 30 minutes by ensureCheckerScheduled).
 */

import { Hono } from 'hono';
import type { TriggerResponse } from '@devvit/web/shared';
import { redis, scheduler } from '@devvit/web/server';
import { ensureCheckerScheduled } from '../checkerSchedule.js';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  await ensureCheckerScheduled({ redis, scheduler }, 'reset');
  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-app-upgrade', async (c) => {
  await ensureCheckerScheduled({ redis, scheduler }, 'reset');
  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-post-submit', async (c) => {
  await ensureCheckerScheduled({ redis, scheduler }, 'heal');
  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-comment-submit', async (c) => {
  await ensureCheckerScheduled({ redis, scheduler }, 'heal');
  return c.json<TriggerResponse>({}, 200);
});
