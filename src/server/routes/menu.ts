/**
 * Subreddit "…" menu items. Only "Review pending post" exists so far —
 * "Configure bot" and "Check for new videos" land in later tickets (see
 * AGENTS.md's repository map).
 */

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { redis, scheduler } from '@devvit/web/server';

import { ensureCheckerScheduled } from '../checkerSchedule.js';
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
