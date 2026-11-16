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
  /** Persisted immediately after Reddit accepts the link post and comment. */
  postId?: `t3_${string}`;
  commentId?: `t1_${string}`;
  /** Set only while one job owns the publication attempt. */
  publishing?: boolean;
}

export type PendingPostTarget = Pick<PendingPost, 'videoId' | 'generatedAt'>;

// Minimal, structurally-typed slices of the Redis/scheduler clients this
// module calls — the same seam checkerSchedule.ts and videoRegistry.ts use.
type RedisClient = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

type RedisTransaction = {
  multi: () => Promise<unknown>;
  set: (key: string, value: string) => Promise<unknown>;
  del: (...keys: string[]) => Promise<unknown>;
  exec: () => Promise<unknown[]>;
  unwatch: () => Promise<unknown>;
};

type WatchableRedisClient = RedisClient & {
  watch: (...keys: string[]) => Promise<RedisTransaction>;
};

type SchedulerClient = {
  cancelJob: (jobId: string) => Promise<void>;
};

function matchesTarget(pending: PendingPost, target: PendingPostTarget): boolean {
  return pending.videoId === target.videoId && pending.generatedAt === target.generatedAt;
}

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

export type PendingPostClaim =
  | { status: 'claimed'; pending: PendingPost }
  | { status: 'missing' | 'stale' | 'busy' | 'conflict'; pending?: undefined };

/**
 * Atomically reserve a Pending Post for its publisher. The record remains in
 * Redis while claimed so a failed run can release the claim and retry.
 */
export async function claimPendingPost(
  redis: WatchableRedisClient,
  target?: PendingPostTarget,
): Promise<PendingPostClaim> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST);
  const pending = await getPendingPost(redis);
  if (!pending) {
    await transaction.unwatch();
    return { status: 'missing' };
  }
  if (target && !matchesTarget(pending, target)) {
    await transaction.unwatch();
    return { status: 'stale' };
  }
  if (pending.publishing) {
    await transaction.unwatch();
    return { status: 'busy' };
  }

  pending.publishing = true;
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return { status: 'claimed', pending };
}

/** Persist accepted Reddit IDs while retaining the exclusive publication claim. */
export async function savePendingPostPublication(
  redis: WatchableRedisClient,
  pending: PendingPost,
  publication: Required<Pick<PendingPost, 'postId' | 'commentId'>>,
): Promise<void> {
  const target: PendingPostTarget = { videoId: pending.videoId, generatedAt: pending.generatedAt };
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST);
  const current = await getPendingPost(redis);
  if (!current || !matchesTarget(current, target) || !current.publishing) {
    await transaction.unwatch();
    throw new Error('Pending post changed before publication progress could be saved.');
  }
  pending.postId = publication.postId;
  pending.commentId = publication.commentId;
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));
  if ((await transaction.exec()).length === 0) {
    throw new Error('Pending post changed before publication progress could be saved.');
  }
}

/** Release a failed publisher's reservation without losing its saved progress. */
export async function releasePendingPostClaim(redis: WatchableRedisClient, pending: PendingPost): Promise<void> {
  const target: PendingPostTarget = { videoId: pending.videoId, generatedAt: pending.generatedAt };
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST);
  const current = await getPendingPost(redis);
  if (!current || !matchesTarget(current, target) || !current.publishing) {
    await transaction.unwatch();
    return;
  }
  pending.publishing = false;
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));
  await transaction.exec();
}

export type PendingPostReviewUpdate =
  | { status: 'updated'; pending: PendingPost }
  | { status: 'missing' | 'stale' | 'busy' | 'conflict'; pending?: undefined };

/** Atomically validate a review form and apply its optional content edits. */
export async function updatePendingPostForReview(
  redis: WatchableRedisClient,
  target: PendingPostTarget,
  updates: Partial<Pick<PendingPost, 'title' | 'body'>>,
): Promise<PendingPostReviewUpdate> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST);
  const pending = await getPendingPost(redis);
  if (!pending) {
    await transaction.unwatch();
    return { status: 'missing' };
  }
  if (!matchesTarget(pending, target)) {
    await transaction.unwatch();
    return { status: 'stale' };
  }
  if (pending.publishing) {
    await transaction.unwatch();
    return { status: 'busy' };
  }
  if (updates.title !== undefined) pending.title = updates.title;
  if (updates.body !== undefined) pending.body = updates.body;
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return { status: 'updated', pending };
}

export type PendingPostResolution =
  | { status: 'resolved'; pending: PendingPost; autoApproveJobId?: string }
  | { status: 'missing' | 'stale' | 'busy' | 'conflict'; pending?: undefined };

/** Atomically remove the exact Pending Post selected in a review form. */
export async function resolvePendingPost(
  redis: WatchableRedisClient,
  target: PendingPostTarget,
): Promise<PendingPostResolution> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID);
  const [pending, autoApproveJobId] = await Promise.all([
    getPendingPost(redis), redis.get(REDIS_KEY_PENDING_POST_JOB_ID),
  ]);
  if (!pending) {
    await transaction.unwatch();
    return { status: 'missing' };
  }
  if (!matchesTarget(pending, target)) {
    await transaction.unwatch();
    return { status: 'stale' };
  }
  if (pending.publishing) {
    await transaction.unwatch();
    return { status: 'busy' };
  }
  await transaction.multi();
  await transaction.del(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID);
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return {
    status: 'resolved',
    pending,
    ...(autoApproveJobId ? { autoApproveJobId } : {}),
  };
}

/** Cancel an auto-approve job after an atomic Pending Post resolution. */
export async function cancelAutoApproveJobById(scheduler: SchedulerClient, jobId?: string): Promise<void> {
  if (!jobId) return;
  try {
    await scheduler.cancelJob(jobId);
  } catch {
    // The timer can already be running; its claim observes the resolved record.
  }
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

/** Decode the immutable target carried by the single-option review form field. */
export function parsePendingPostTarget(values: { pendingPostTarget?: unknown }): PendingPostTarget | null {
  const raw = Array.isArray(values.pendingPostTarget) ? values.pendingPostTarget[0] : values.pendingPostTarget;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingPostTarget>;
    return typeof parsed.videoId === 'string' && parsed.videoId && typeof parsed.generatedAt === 'string' && parsed.generatedAt
      ? { videoId: parsed.videoId, generatedAt: parsed.generatedAt }
      : null;
  } catch {
    return null;
  }
}

/** Build the "Review pending post" form, pre-filled with the Pending Post's content. */
export function buildReviewPendingPostForm(data: {
  title: string;
  body: string;
  videoTitle: string;
  videoId: string;
  generatedAt: string;
}): Form {
  const target = JSON.stringify({ videoId: data.videoId, generatedAt: data.generatedAt });
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
      type: 'select',
      name: 'pendingPostTarget',
      label: 'Reviewing video',
      options: [{ label: data.videoTitle, value: target }],
      defaultValue: [target],
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
