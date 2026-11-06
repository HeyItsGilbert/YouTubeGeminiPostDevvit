/**
 * `post_pending_episode` scheduler task — publishes a mod-approved or
 * auto-approved Pending Post through the same link-post-plus-stickied-
 * comment, flair, and pin-rotation path as an immediate post (see
 * `check-episodes.ts` step 7-9). Triggered immediately (with job data
 * `{ triggeredBy }`) by the "Review pending post" form's Publish action, or
 * scheduled ahead by `check_new_episodes` when `autoApproveWindowMinutes` is
 * configured. A missing Pending Post (already published, discarded, or
 * rejected by the time this runs) is a no-op, not an error.
 */

import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { context, reddit, redis, settings } from '@devvit/web/server';

import { createEpisodePost, applyBotFlair, applyFlair, managePins } from '../postManager.js';
import { setVideoRecord } from '../videoRegistry.js';
import { getPendingPost, REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID } from '../pendingPost.js';
import { sendFailureNotification, FAILURE_HELP } from '../notifications.js';

export const pendingPost = new Hono();

pendingPost.post('/post-pending-episode', async (c) => {
  const event = await c.req.json<TaskRequest<{ triggeredBy?: string }>>();
  let notificationMods: string[] = [];

  try {
    const pending = await getPendingPost(redis);
    if (!pending) {
      console.log('[bot] post_pending_episode: no pending post found (already published, discarded, or rejected).');
      return c.json<TaskResponse>({}, 200);
    }

    const subredditName = context.subredditName;
    const [flairName, botFlairEmoji, botFlairText, notificationModsSetting] = await Promise.all([
      settings.get<string>('flairName').then(v => v || ''),
      settings.get<string>('botFlairEmoji').then(v => v || ''),
      settings.get<string>('botFlairText').then(v => v || ''),
      settings.get<string>('notificationMods').then(v => v || ''),
    ]);
    notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

    console.log(`[bot] Posting pending episode: "${pending.title}"`);
    const { postId, commentId } = await createEpisodePost(reddit, subredditName, pending.title, pending.url, pending.body);
    console.log(`[bot] Created post ${postId} with discussion comment ${commentId}`);

    await Promise.all([
      flairName ? applyFlair(reddit, subredditName, postId, flairName) : Promise.resolve(),
      applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText),
      managePins(reddit, redis, postId),
    ]);

    await setVideoRecord(redis, pending.videoId, {
      title: pending.videoTitle,
      status: 'posted',
      postId,
      commentId,
      processedAt: new Date().toISOString(),
    });

    // Clean up pending state — the auto-approve job (if any) either just
    // fired (this invocation) or was already cancelled by the mod action
    // that triggered this run, so only the Redis keys need clearing here.
    await redis.del(REDIS_KEY_PENDING_POST);
    await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);

    console.log(`[bot] Pending episode posted: "${pending.title}"`);
  } catch (err) {
    console.error(`[bot] Failed to post pending episode: ${err}`);
    const triggeredBy = event.data?.triggeredBy ?? await redis.get('check_triggered_by');
    await sendFailureNotification(
      reddit,
      notificationMods,
      triggeredBy,
      'Episode post failed',
      `Failed to post the pending episode on r/${context.subredditName} with error:\n\n    ${err}\n\nThe episode content is still saved. Try "Review pending post" (in the subreddit's "…" menu) to retry.\n\n${FAILURE_HELP}`,
    );
  }

  return c.json<TaskResponse>({}, 200);
});
