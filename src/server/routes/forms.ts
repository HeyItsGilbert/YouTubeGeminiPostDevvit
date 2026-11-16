/**
 * "Review pending post" form submit handler — one form, three actions.
 * Publish (optionally after editing) triggers `post_pending_episode`
 * immediately with job data `{ triggeredBy }` so a failure PMs the
 * submitting mod; Discard and Reject resolve the Pending Post directly.
 * Every branch returns only a toast — never a form (see AGENTS.md's "no
 * endpoint returns both a toast and a form" rule).
 */

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, reddit, redis, scheduler } from '@devvit/web/server';

import {
  cancelAutoApproveJob,
  cancelAutoApproveJobById,
  parsePendingPostTarget,
  parseReviewAction,
  resolvePendingPost,
  updatePendingPostForReview,
} from '../pendingPost.js';
import { deleteVideoRecord, setVideoRecord } from '../videoRegistry.js';
import { isPlaytestInstall, scheduleManualCheck } from '../manualCheck.js';

export const forms = new Hono();

const ALREADY_RESOLVED_TOAST =
  'No pending post found. It may have already been published, discarded, or rejected.';

type ReviewFormValues = {
  action?: string[] | string;
  pendingPostTarget?: string[] | string;
  postTitle?: string;
  postBody?: string;
};

forms.post('/review-pending-post-submit', async (c) => {
  const values = await c.req.json<ReviewFormValues>();
  const target = parsePendingPostTarget(values);
  if (!target) {
    return c.json<UiResponse>({ showToast: 'This review form is invalid. Open "Review pending post" and try again.' }, 200);
  }
  const action = parseReviewAction(values);

  if (action === 'discard' || action === 'reject') {
    const resolution = await resolvePendingPost(redis, target);
    if (resolution.status !== 'resolved') {
      const showToast = resolution.status === 'stale'
        ? 'This review form is stale. Open "Review pending post" and try again.'
        : resolution.status === 'busy'
          ? 'This pending post is already being published. Try again shortly.'
          : ALREADY_RESOLVED_TOAST;
      return c.json<UiResponse>({ showToast }, 200);
    }
    await cancelAutoApproveJobById(scheduler, resolution.autoApproveJobId);
    if (action === 'discard') {
      await deleteVideoRecord(redis, resolution.pending.videoId);
      return c.json<UiResponse>({ showToast: 'Pending post discarded.' }, 200);
    }
    await setVideoRecord(redis, resolution.pending.videoId, {
      title: resolution.pending.videoTitle,
      status: 'rejected',
      processedAt: new Date().toISOString(),
    });
    return c.json<UiResponse>({ showToast: `Rejected "${resolution.pending.videoTitle}". It will not be posted.` }, 200);
  }

  // Publish — validate the exact form target and write its edits atomically.
  const update = await updatePendingPostForReview(redis, target, {
    ...(values.postTitle !== undefined ? { title: values.postTitle.trim() } : {}),
    ...(values.postBody !== undefined ? { body: values.postBody.trim() } : {}),
  });
  if (update.status !== 'updated') {
    const showToast = update.status === 'stale'
      ? 'This review form is stale. Open "Review pending post" and try again.'
      : update.status === 'busy'
        ? 'This pending post is already being published. Try again shortly.'
        : ALREADY_RESOLVED_TOAST;
    return c.json<UiResponse>({ showToast }, 200);
  }

  // Publishing now supersedes any auto-approve timer. A timer that already
  // started cannot duplicate the post because the job claims it atomically.
  await cancelAutoApproveJob(redis, scheduler);

  const triggeredBy = await reddit.getCurrentUsername();
  await scheduler.runJob({
    name: 'post_pending_episode',
    runAt: new Date(),
    data: triggeredBy ? { triggeredBy } : undefined,
  });

  return c.json<UiResponse>({ showToast: 'Publishing pending post...' }, 200);
});

forms.post('/check-new-videos-submit', async (c) => {
  const values = await c.req.json<{ forceRepost?: boolean }>();
  const forceRepost = values.forceRepost === true && isPlaytestInstall(context.appVersion);
  await scheduleManualCheck({ reddit, redis, scheduler }, forceRepost);
  const showToast = values.forceRepost === true && !forceRepost
    ? 'Force repost is available only on a playtest install. Checking for new videos normally.'
    : 'Checking for new videos. You will get a message if nothing is posted.';
  return c.json<UiResponse>({ showToast }, 200);
});
