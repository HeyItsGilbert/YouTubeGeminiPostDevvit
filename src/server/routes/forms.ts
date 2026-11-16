/**
 * "Review pending post" form submit handler — one form, three actions.
 * Publish (optionally after editing) triggers `post_pending_episode` with the
 * exact video/generation target and optional triggering mod; Discard and Reject
 * resolve the Pending Post and matching registry record atomically.
 * Every branch returns only a toast — never a form (see AGENTS.md's "no
 * endpoint returns both a toast and a form" rule).
 */

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { reddit, redis, scheduler } from '@devvit/web/server';

import {
  cancelAutoApproveJobById,
  clearAutoApproveJobForPendingPost,
  parsePendingPostTarget,
  parseReviewAction,
  resolvePendingPost,
  updatePendingPostForReview,
} from '../pendingPost.js';

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
    const resolution = await resolvePendingPost(redis, target, action);
    if (resolution.status !== 'resolved') {
      const showToast = resolution.status === 'stale'
        ? 'This review form is stale. Open "Review pending post" and try again.'
        : resolution.status === 'busy'
          ? 'This pending post is already being published. Try again shortly.'
          : resolution.status === 'partially-published'
            ? 'This post was partly published. Choose Publish to finish it; it cannot be discarded or rejected.'
            : ALREADY_RESOLVED_TOAST;
      return c.json<UiResponse>({ showToast }, 200);
    }
    await cancelAutoApproveJobById(scheduler, resolution.autoApproveJobId);
    if (action === 'discard') {
      return c.json<UiResponse>({ showToast: 'Pending post discarded.' }, 200);
    }
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
        : update.status === 'title-immutable'
          ? 'The Reddit link-post title cannot change. Reopen the form and edit only the discussion comment.'
          : update.status === 'reconciliation-required'
            ? 'The previous Reddit publication outcome is still being reconciled. Submit the unchanged form to retry safely.'
            : ALREADY_RESOLVED_TOAST;
    return c.json<UiResponse>({ showToast }, 200);
  }

  let triggeredBy: string | undefined;
  try {
    triggeredBy = await reddit.getCurrentUsername();
    await scheduler.runJob({
      name: 'post_pending_episode',
      runAt: new Date(),
      data: {
        videoId: target.videoId,
        generatedAt: target.generatedAt,
        ...(triggeredBy ? { triggeredBy } : {}),
      },
    });
  } catch (err) {
    console.error(`[bot] Failed to schedule pending post publication: ${err}`);
    return c.json<UiResponse>({
      showToast: 'Could not schedule publication. The auto-approval timer is still active; try Publish again shortly.',
    }, 200);
  }

  // Retire only the timer owned by this exact Pending Post after its
  // replacement publisher exists. If cancellation loses a race, both jobs
  // carry the same target and the publication lease permits only one.
  const autoApproveJobId = await clearAutoApproveJobForPendingPost(redis, target);
  await cancelAutoApproveJobById(scheduler, autoApproveJobId);

  return c.json<UiResponse>({ showToast: 'Publishing pending post...' }, 200);
});
