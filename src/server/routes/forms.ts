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
import { reddit, redis, scheduler } from '@devvit/web/server';

import {
  REDIS_KEY_PENDING_POST,
  cancelAutoApproveJob,
  clearPendingPost,
  getPendingPost,
  parseReviewAction,
} from '../pendingPost.js';
import { deleteVideoRecord, setVideoRecord } from '../videoRegistry.js';
import { scheduleManualCheck } from '../manualCheck.js';

export const forms = new Hono();

const ALREADY_RESOLVED_TOAST =
  'No pending post found. It may have already been published, discarded, or rejected.';

type ReviewFormValues = {
  action?: string[] | string;
  postTitle?: string;
  postBody?: string;
};

forms.post('/review-pending-post-submit', async (c) => {
  const values = await c.req.json<ReviewFormValues>();
  const action = parseReviewAction(values);

  if (action === 'discard') {
    const pending = await clearPendingPost(redis, scheduler);
    if (!pending) {
      return c.json<UiResponse>({ showToast: ALREADY_RESOLVED_TOAST }, 200);
    }
    await deleteVideoRecord(redis, pending.videoId);
    return c.json<UiResponse>({ showToast: 'Pending post discarded.' }, 200);
  }

  if (action === 'reject') {
    const pending = await clearPendingPost(redis, scheduler);
    if (!pending) {
      return c.json<UiResponse>({ showToast: ALREADY_RESOLVED_TOAST }, 200);
    }
    await setVideoRecord(redis, pending.videoId, {
      title: pending.videoTitle,
      status: 'rejected',
      processedAt: new Date().toISOString(),
    });
    return c.json<UiResponse>({ showToast: `Rejected "${pending.videoTitle}". It will not be posted.` }, 200);
  }

  // Publish — write any edits back, then trigger post_pending_episode now.
  const pending = await getPendingPost(redis);
  if (!pending) {
    return c.json<UiResponse>({ showToast: ALREADY_RESOLVED_TOAST }, 200);
  }
  pending.title = (values.postTitle ?? pending.title).trim();
  pending.body = (values.postBody ?? pending.body).trim();
  await redis.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));

  // Publishing now supersedes any auto-approve timer.
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
  await scheduleManualCheck({ reddit, redis, scheduler }, values.forceRepost === true);
  return c.json<UiResponse>({ showToast: 'Checking for new videos. You will get a message if nothing is posted.' }, 200);
});
