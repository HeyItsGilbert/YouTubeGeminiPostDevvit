/**
 * Mod-approval gate state: the Pending Post held in Redis while a mod
 * reviews it, and the pure helpers "Review pending post" (menu + form,
 * `src/server/routes/menu.ts` / `forms.ts`) and the `post_pending_episode`
 * job (`src/server/routes/pending-post.ts`) share.
 */

import type { Form, FormField } from '@devvit/shared-types/shared/form.js';

export const REDIS_KEY_PENDING_POST = 'pending_post';
export const REDIS_KEY_PENDING_POST_JOB_ID = 'pending_post_job_id';

export interface PendingPost {
  title: string;
  body: string;
  url: string;
  videoId: string;
  videoTitle: string;
  generatedAt: string;
}

// Minimal, structurally-typed slices of the Redis/scheduler clients this
// module calls — the same seam checkerSchedule.ts and videoRegistry.ts use.
type RedisClient = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

type SchedulerClient = {
  cancelJob: (jobId: string) => Promise<void>;
};

/** Read and parse the Pending Post, or null if none is stored (or it's corrupt). */
export async function getPendingPost(redis: RedisClient): Promise<PendingPost | null> {
  const json = await redis.get(REDIS_KEY_PENDING_POST);
  if (!json) return null;
  try {
    return JSON.parse(json) as PendingPost;
  } catch {
    return null;
  }
}

/** Cancel the scheduled auto-approve job, if one is pending, and clear its Redis key. */
export async function cancelAutoApproveJob(redis: RedisClient, scheduler: SchedulerClient): Promise<void> {
  const existingJobId = await redis.get(REDIS_KEY_PENDING_POST_JOB_ID);
  if (existingJobId) {
    try {
      await scheduler.cancelJob(existingJobId);
    } catch {
      // Already fired or already gone — nothing left to cancel.
    }
    await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);
  }
}

/**
 * Remove the Pending Post and cancel its auto-approve timer (if any).
 * Returns the removed Pending Post, or null if none was pending.
 */
export async function clearPendingPost(
  redis: RedisClient,
  scheduler: SchedulerClient,
): Promise<PendingPost | null> {
  const pending = await getPendingPost(redis);
  if (!pending) return null;
  await cancelAutoApproveJob(redis, scheduler);
  await redis.del(REDIS_KEY_PENDING_POST);
  return pending;
}

export type ReviewAction = 'publish' | 'discard' | 'reject';

/**
 * Parse the review form's `action` select field. Devvit select fields submit
 * their value as a string array; anything other than `discard`/`reject`
 * (including a missing or malformed value) defaults to `publish`.
 */
export function parseReviewAction(values: { action?: unknown }): ReviewAction {
  const raw = Array.isArray(values.action) ? values.action[0] : values.action;
  return raw === 'discard' || raw === 'reject' ? raw : 'publish';
}

/** Build the "Review pending post" form, pre-filled with the Pending Post's content. */
export function buildReviewPendingPostForm(data: {
  title: string;
  body: string;
  videoTitle: string;
}): Form {
  const fields: FormField[] = [
    {
      type: 'select',
      name: 'action',
      label: 'Action',
      options: [
        { label: 'Publish', value: 'publish' },
        { label: 'Discard (the video is treated as unseen on the next check)', value: 'discard' },
        { label: 'Reject (never post this video)', value: 'reject' },
      ],
      defaultValue: ['publish'],
      required: true,
    },
    {
      type: 'string',
      name: 'postTitle',
      label: 'Post Title',
      defaultValue: data.title,
      required: true,
    },
    {
      type: 'paragraph',
      name: 'postBody',
      label: 'Discussion Comment Body',
      defaultValue: data.body,
      required: true,
    },
  ];

  return {
    title: 'Review pending post',
    description: `Video: ${data.videoTitle}. Submit within about 10 minutes of opening this form — Reddit silently drops a stale submission, so reopen "Review pending post" and try again if nothing happens after you submit.`,
    fields,
    acceptLabel: 'Submit',
    cancelLabel: 'Close',
  };
}
