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
import {
  REDIS_KEY_PENDING_POST,
  REDIS_KEY_PENDING_POST_JOB_ID,
  claimPendingPost,
  releasePendingPostClaim,
  savePendingPostPublication,
  type PendingPost,
} from '../pendingPost.js';
import { sendFailureNotification, FAILURE_HELP } from '../notifications.js';

export const pendingPost = new Hono();

pendingPost.post('/post-pending-episode', async (c) => {
  const event = await c.req.json<TaskRequest<{ triggeredBy?: string }>>();
  let notificationMods: string[] = [];
  let claimed: PendingPost | undefined;

  try {
    const claim = await claimPendingPost(redis);
    if (claim.status !== 'claimed') {
      console.log(`[bot] post_pending_episode: pending post is ${claim.status}.`);
      return c.json<TaskResponse>({}, 200);
    }
    claimed = claim.pending;

    const subredditName = context.subredditName;
    const [flairName, botFlairEmoji, botFlairText, notificationModsSetting] = await Promise.all([
      settings.get<string>('flairName').then(v => v || ''),
      settings.get<string>('botFlairEmoji').then(v => v || ''),
      settings.get<string>('botFlairText').then(v => v || ''),
      settings.get<string>('notificationMods').then(v => v || ''),
    ]);
    notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

    let { postId, commentId } = claimed;
    if (!postId || !commentId) {
      console.log(`[bot] Posting pending episode: "${claimed.title}"`);
      const created = await createEpisodePost(reddit, subredditName, claimed.title, claimed.url, claimed.body);
      postId = created.postId;
      commentId = created.commentId;
      // Pinning can fail after Reddit has accepted both creations. Store this
      // progress first so the next attempt finishes the existing post.
      await savePendingPostPublication(redis, claimed, { postId, commentId });
      console.log(`[bot] Created post ${postId} with discussion comment ${commentId}`);
    }

    await Promise.all([
      flairName ? applyFlair(reddit, subredditName, postId, flairName) : Promise.resolve(),
      applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText),
      managePins(reddit, redis, postId),
    ]);

    await setVideoRecord(redis, claimed.videoId, {
      title: claimed.videoTitle,
      status: 'posted',
      postId,
      commentId,
      processedAt: new Date().toISOString(),
    });

    // The successful claim is still the only writer for this record.
    await redis.del(REDIS_KEY_PENDING_POST);
    await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);
    console.log(`[bot] Pending episode posted: "${claimed.title}"`);
  } catch (err) {
    console.error(`[bot] Failed to post pending episode: ${err}`);
    if (claimed) await releasePendingPostClaim(redis, claimed);
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
