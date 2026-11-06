/**
 * Subreddit "…" menu items for the mod-approval and manual-check features.
 */

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, reddit, redis, scheduler } from '@devvit/web/server';

import { ensureCheckerScheduled } from '../checkerSchedule.js';
import { buildPlaytestCheckForm, isPlaytestInstall, scheduleManualCheck } from '../manualCheck.js';
import { buildReviewPendingPostForm, getPendingPost } from '../pendingPost.js';

export const menu = new Hono();

menu.post('/review-pending-post', async (c) => {
  // Every mod menu press also re-verifies the checker cron (see AGENTS.md's
  // "Scheduler jobs" section on why AppInstall/AppUpgrade alone is unreliable).
  await ensureCheckerScheduled({ redis, scheduler }, 'heal');

  const pending = await getPendingPost(redis);
  if (!pending) {
    return c.json<UiResponse>({ showToast: 'No post is pending approval.' }, 200);
  }

  return c.json<UiResponse>(
    {
      showForm: {
        name: 'reviewPendingPost',
        form: buildReviewPendingPostForm(pending),
      },
    },
    200,
  );
});

menu.post('/check-new-videos', async (c) => {
  await ensureCheckerScheduled({ redis, scheduler }, 'heal');

  if (isPlaytestInstall(context.appVersion)) {
    return c.json<UiResponse>({
      showForm: { name: 'checkNewVideos', form: buildPlaytestCheckForm() },
    }, 200);
  }

  await scheduleManualCheck({ reddit, redis, scheduler }, false);
  return c.json<UiResponse>({ showToast: 'Checking for new videos. You will get a message if nothing is posted.' }, 200);
});
