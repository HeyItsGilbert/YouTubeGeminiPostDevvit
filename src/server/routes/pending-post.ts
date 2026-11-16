/**
 * `post_pending_episode` scheduler task — publishes one exact Pending Post.
 * Both manual and auto-approve jobs carry the immutable video/generation
 * target, so delayed jobs cannot publish a replacement queue entry.
 */

import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { context, reddit, redis, scheduler, settings } from '@devvit/web/server';

import {
  applyBotFlair,
  applyFlair,
  createEpisodeDiscussionComment,
  createEpisodeLinkPost,
  distinguishEpisodeDiscussionComment,
  findEpisodeDiscussionComment,
  findEpisodeLinkPost,
  managePins,
  updateEpisodePost,
} from '../postManager.js';
import {
  beginPendingPostPublication,
  cancelAutoApproveJobById,
  claimPendingPost,
  completePendingPostPublication,
  releasePendingPostClaim,
  saveAcceptedPendingPostPublication,
  type PendingPost,
  type PendingPostTarget,
} from '../pendingPost.js';
import {
  sendFailureNotification,
  sendModInboxFailureNotification,
  FAILURE_HELP,
} from '../notifications.js';

export const pendingPost = new Hono();

type PendingPostJobData = {
  triggeredBy?: string;
  videoId?: string;
  generatedAt?: string;
};

function parsePendingPostJobTarget(data: PendingPostJobData | undefined): PendingPostTarget | null {
  if (!data?.videoId || !data.generatedAt) return null;
  return { videoId: data.videoId, generatedAt: data.generatedAt };
}

pendingPost.post('/post-pending-episode', async (c) => {
  const event = await c.req.json<TaskRequest<PendingPostJobData>>();
  const target = parsePendingPostJobTarget(event.data);
  if (!target) {
    console.log('[bot] post_pending_episode: job has no pending-post target.');
    return c.json<TaskResponse>({}, 200);
  }

  let notificationMods: string[] = [];
  let claimed: PendingPost | undefined;

  try {
    const claim = await claimPendingPost(redis, target);
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

    if (claimed.publicationPhase === 'link-post') {
      const recoveredPostId = await findEpisodeLinkPost(
        reddit,
        subredditName,
        claimed.title,
        claimed.url,
        claimed.generatedAt,
      );
      if (!recoveredPostId) {
        throw new Error('Reddit link-post creation outcome is unknown and could not be reconciled safely.');
      }
      claimed = await saveAcceptedPendingPostPublication(redis, claimed, { postId: recoveredPostId });
    }
    if (claimed.publicationPhase === 'discussion-comment') {
      if (!claimed.postId) {
        throw new Error('Reddit discussion-comment creation cannot be reconciled without its link post ID.');
      }
      const recoveredCommentId = await findEpisodeDiscussionComment(reddit, claimed.postId, claimed.body);
      if (!recoveredCommentId) {
        throw new Error('Reddit discussion-comment creation outcome is unknown and could not be reconciled safely.');
      }
      claimed = await saveAcceptedPendingPostPublication(redis, claimed, { commentId: recoveredCommentId });
    }

    let { postId, commentId } = claimed;
    if (!postId) {
      claimed = await beginPendingPostPublication(redis, claimed, 'link-post');
      console.log(`[bot] Posting pending episode: "${claimed.title}"`);
      postId = await createEpisodeLinkPost(reddit, subredditName, claimed.title, claimed.url);
      claimed = await saveAcceptedPendingPostPublication(redis, claimed, { postId });
      console.log(`[bot] Created post ${postId}`);
    }
    if (!commentId) {
      claimed = await beginPendingPostPublication(redis, claimed, 'discussion-comment');
      commentId = await createEpisodeDiscussionComment(reddit, postId, claimed.body);
      claimed = await saveAcceptedPendingPostPublication(redis, claimed, { commentId });
      console.log(`[bot] Created discussion comment ${commentId}`);
    } else {
      // Link-post titles are immutable. A retry applies any review edits to the
      // durable Discussion Comment before completing the remaining operations.
      await updateEpisodePost(reddit, commentId, claimed.body);
    }
    await distinguishEpisodeDiscussionComment(reddit, commentId);

    await Promise.all([
      flairName ? applyFlair(reddit, subredditName, postId, flairName) : Promise.resolve(),
      applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText),
      managePins(reddit, redis, postId),
    ]);

    const completion = await completePendingPostPublication(redis, claimed, new Date().toISOString());
    if (completion.status !== 'completed') {
      throw new Error('Pending post claim was lost before completion could be recorded.');
    }
    await cancelAutoApproveJobById(scheduler, completion.autoApproveJobId);
    console.log(`[bot] Pending episode posted: "${claimed.title}"`);
  } catch (err) {
    console.error(`[bot] Failed to post pending episode: ${err}`);
    if (claimed) await releasePendingPostClaim(redis, claimed);
    const triggeredBy = event.data?.triggeredBy;
    const subject = 'Episode post failed';
    const text = `Failed to post the pending episode on r/${context.subredditName} with error:\n\n    ${err}\n\nThe episode content is still saved. Try "Review pending post" (in the subreddit's "…" menu) to retry.\n\n${FAILURE_HELP}`;
    await sendFailureNotification(reddit, notificationMods, triggeredBy, subject, text);
    if (notificationMods.length === 0 && !triggeredBy) {
      await sendModInboxFailureNotification(reddit, context.subredditName, subject, text);
    }
  }

  return c.json<TaskResponse>({}, 200);
});
