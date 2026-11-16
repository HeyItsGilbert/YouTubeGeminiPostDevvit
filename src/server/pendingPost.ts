/**
 * Mod-approval gate state: the Pending Post held in Redis while a mod
 * reviews it, and the pure helpers "Review pending post" (menu + form,
 * `src/server/routes/menu.ts` / `forms.ts`) and the `post_pending_episode`
 * job (`src/server/routes/pending-post.ts`) share.
 */

import { randomUUID } from 'node:crypto';

import type { Form, FormField } from '@devvit/shared-types/shared/form.js';

import type { VideoRecord } from '../types.js';
import { REGISTRY_KEY } from './videoRegistry.js';

export const REDIS_KEY_PENDING_POST = 'pending_post';
export const REDIS_KEY_PENDING_POST_JOB_ID = 'pending_post_job_id';

/** Longer than an invocation but bounded so a terminated publisher cannot block the queue. */
export const PENDING_POST_LEASE_MS = 5 * 60 * 1000;

export interface PublicationLease {
  owner: string;
  expiresAt: string;
}

export interface PendingPost {
  title: string;
  body: string;
  url: string;
  videoId: string;
  videoTitle: string;
  generatedAt: string;
  /** Persisted as each Reddit object is accepted, so retries resume safely. */
  postId?: `t3_${string}`;
  commentId?: `t1_${string}`;
  /** Bounded publisher ownership; absent or expired leases are retryable. */
  publicationLease?: PublicationLease;
}

export type PendingPostTarget = Pick<PendingPost, 'videoId' | 'generatedAt'>;

type PendingStore = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<unknown>;
  del: (...keys: string[]) => Promise<unknown>;
};

type RegistryStore = {
  hGet: (key: string, field: string) => Promise<string | undefined>;
};

type RedisTransaction = {
  multi: () => Promise<unknown>;
  set: (key: string, value: string) => Promise<unknown>;
  del: (...keys: string[]) => Promise<unknown>;
  hSet: (key: string, values: Record<string, string>) => Promise<unknown>;
  hDel: (key: string, fields: string[]) => Promise<unknown>;
  exec: () => Promise<unknown[]>;
  unwatch: () => Promise<unknown>;
};

type WatchableRedisClient = PendingStore & RegistryStore & {
  watch: (...keys: string[]) => Promise<RedisTransaction>;
};

type SchedulerClient = {
  cancelJob: (jobId: string) => Promise<void>;
};

function matchesTarget(pending: PendingPost, target: PendingPostTarget): boolean {
  return pending.videoId === target.videoId && pending.generatedAt === target.generatedAt;
}

function isLeaseActive(pending: PendingPost, now: Date): boolean {
  const expiresAt = pending.publicationLease && Date.parse(pending.publicationLease.expiresAt);
  return Boolean(expiresAt && expiresAt > now.getTime());
}

function hasCurrentLease(current: PendingPost, claimed: PendingPost, now: Date): boolean {
  return matchesTarget(current, claimed)
    && Boolean(claimed.publicationLease)
    && current.publicationLease?.owner === claimed.publicationLease?.owner
    && isLeaseActive(current, now);
}

function hasPublicationProgress(pending: PendingPost): boolean {
  return Boolean(pending.postId || pending.commentId);
}

function parseVideoRecord(json: string | undefined): VideoRecord | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as VideoRecord;
  } catch {
    return undefined;
  }
}


/** Read and parse the Pending Post, or null if none is stored (or it's corrupt). */
export async function getPendingPost(redis: Pick<PendingStore, 'get'>): Promise<PendingPost | null> {
  const json = await redis.get(REDIS_KEY_PENDING_POST);
  if (!json) return null;
  try {
    return JSON.parse(json) as PendingPost;
  } catch {
    return null;
  }
}

export type PendingPostEnqueue =
  | { status: 'queued'; orphanedAutoApproveJobId?: string }
  | { status: 'occupied' | 'conflict'; orphanedAutoApproveJobId?: undefined };

/**
 * Claim an empty queue and record its video in one Redis transaction. This is
 * the checker-side counterpart to owner-checked publication cleanup.
 */
export async function enqueuePendingPost(
  redis: WatchableRedisClient,
  pending: PendingPost,
): Promise<PendingPostEnqueue> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID, REGISTRY_KEY);
  const [existing, orphanedAutoApproveJobId, registryJson] = await Promise.all([
    getPendingPost(redis),
    redis.get(REDIS_KEY_PENDING_POST_JOB_ID),
    redis.hGet(REGISTRY_KEY, pending.videoId),
  ]);
  if (existing) {
    await transaction.unwatch();
    return { status: 'occupied' };
  }

  const existingRecord = parseVideoRecord(registryJson);
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));
  await transaction.del(REDIS_KEY_PENDING_POST_JOB_ID);
  if (existingRecord?.status !== 'posted') {
    await transaction.hSet(REGISTRY_KEY, {
      [pending.videoId]: JSON.stringify({
        title: pending.videoTitle,
        status: 'pending',
        processedAt: new Date().toISOString(),
      } satisfies VideoRecord),
    });
  }
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return {
    status: 'queued',
    ...(orphanedAutoApproveJobId ? { orphanedAutoApproveJobId } : {}),
  };
}

export type AutoApproveJobReservation =
  | { status: 'reserved' }
  | { status: 'missing' | 'stale' | 'already-scheduled' | 'conflict' };

/** Bind an externally-created scheduler job to the exact Pending Post that owns it. */
export async function reserveAutoApproveJob(
  redis: WatchableRedisClient,
  target: PendingPostTarget,
  jobId: string,
): Promise<AutoApproveJobReservation> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID);
  const [pending, existingJobId] = await Promise.all([
    getPendingPost(redis),
    redis.get(REDIS_KEY_PENDING_POST_JOB_ID),
  ]);
  if (!pending) {
    await transaction.unwatch();
    return { status: 'missing' };
  }
  if (!matchesTarget(pending, target)) {
    await transaction.unwatch();
    return { status: 'stale' };
  }
  if (existingJobId) {
    await transaction.unwatch();
    return { status: 'already-scheduled' };
  }
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST_JOB_ID, jobId);
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return { status: 'reserved' };
}

export type PendingPostClaim =
  | { status: 'claimed'; pending: PendingPost }
  | { status: 'missing' | 'stale' | 'busy' | 'conflict'; pending?: undefined };

export type PendingPostClaimOptions = {
  owner?: string;
  now?: Date;
};

/**
 * Atomically lease one exact Pending Post to its publisher. The lease has an
 * owner token and expiry, allowing a later job to recover after termination.
 */
export async function claimPendingPost(
  redis: WatchableRedisClient,
  target: PendingPostTarget,
  options: PendingPostClaimOptions = {},
): Promise<PendingPostClaim> {
  const now = options.now ?? new Date();
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
  if (isLeaseActive(pending, now)) {
    await transaction.unwatch();
    return { status: 'busy' };
  }

  pending.publicationLease = {
    owner: options.owner ?? randomUUID(),
    expiresAt: new Date(now.getTime() + PENDING_POST_LEASE_MS).toISOString(),
  };
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return { status: 'claimed', pending };
}

/** Persist accepted Reddit IDs individually while retaining the owning lease. */
export async function savePendingPostPublication(
  redis: WatchableRedisClient,
  claimed: PendingPost,
  publication: Pick<PendingPost, 'postId' | 'commentId'>,
): Promise<PendingPost> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST);
  const current = await getPendingPost(redis);
  if (!current || !hasCurrentLease(current, claimed, new Date())) {
    await transaction.unwatch();
    throw new Error('Pending post claim was lost before publication progress could be saved.');
  }
  if (publication.postId && current.postId && publication.postId !== current.postId) {
    await transaction.unwatch();
    throw new Error('Pending post already has a different Reddit post ID.');
  }
  if (publication.commentId && current.commentId && publication.commentId !== current.commentId) {
    await transaction.unwatch();
    throw new Error('Pending post already has a different Reddit comment ID.');
  }
  const updated = { ...current, ...publication };
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(updated));
  if ((await transaction.exec()).length === 0) {
    throw new Error('Pending post changed before publication progress could be saved.');
  }
  return updated;
}

/** Release only this publisher's lease, preserving any progress it saved. */
export async function releasePendingPostClaim(redis: WatchableRedisClient, claimed: PendingPost): Promise<void> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST);
  const current = await getPendingPost(redis);
  if (!current || !matchesTarget(current, claimed)
    || current.publicationLease?.owner !== claimed.publicationLease?.owner) {
    await transaction.unwatch();
    return;
  }
  delete current.publicationLease;
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(current));
  await transaction.exec();
}

export type PendingPostReviewUpdate =
  | { status: 'updated'; pending: PendingPost }
  | { status: 'missing' | 'stale' | 'busy' | 'title-immutable' | 'conflict'; pending?: undefined };

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
  if (isLeaseActive(pending, new Date())) {
    await transaction.unwatch();
    return { status: 'busy' };
  }
  if (pending.postId && updates.title !== undefined && updates.title !== pending.title) {
    await transaction.unwatch();
    return { status: 'title-immutable' };
  }
  if (updates.title !== undefined) pending.title = updates.title;
  if (updates.body !== undefined) pending.body = updates.body;
  delete pending.publicationLease;
  await transaction.multi();
  await transaction.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return { status: 'updated', pending };
}

export type PendingPostResolution =
  | { status: 'resolved'; pending: PendingPost; autoApproveJobId?: string }
  | { status: 'missing' | 'stale' | 'busy' | 'partially-published' | 'conflict'; pending?: undefined };

/**
 * Atomically resolve an unpublished Pending Post and update the video registry.
 * Scheduler cancellation follows this commit, so no queue state is lost if it
 * cannot be cancelled.
 */
export async function resolvePendingPost(
  redis: WatchableRedisClient,
  target: PendingPostTarget,
  action: 'discard' | 'reject',
): Promise<PendingPostResolution> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID, REGISTRY_KEY);
  const [pending, autoApproveJobId, registryJson] = await Promise.all([
    getPendingPost(redis),
    redis.get(REDIS_KEY_PENDING_POST_JOB_ID),
    redis.hGet(REGISTRY_KEY, target.videoId),
  ]);
  if (!pending) {
    await transaction.unwatch();
    return { status: 'missing' };
  }
  if (!matchesTarget(pending, target)) {
    await transaction.unwatch();
    return { status: 'stale' };
  }
  if (isLeaseActive(pending, new Date())) {
    await transaction.unwatch();
    return { status: 'busy' };
  }
  if (hasPublicationProgress(pending)) {
    await transaction.unwatch();
    return { status: 'partially-published' };
  }

  const existingRecord = parseVideoRecord(registryJson);
  await transaction.multi();
  await transaction.del(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID);
  if (existingRecord?.status !== 'posted' && action === 'discard') {
    await transaction.hDel(REGISTRY_KEY, [pending.videoId]);
  }
  if (existingRecord?.status !== 'posted' && action === 'reject') {
    await transaction.hSet(REGISTRY_KEY, {
      [pending.videoId]: JSON.stringify({
        title: pending.videoTitle,
        status: 'rejected',
        processedAt: new Date().toISOString(),
      } satisfies VideoRecord),
    });
  }
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return {
    status: 'resolved',
    pending,
    ...(autoApproveJobId ? { autoApproveJobId } : {}),
  };
}

export type PendingPostCompletion =
  | { status: 'completed'; autoApproveJobId?: string }
  | { status: 'lost-claim' | 'conflict' };

/** Atomically mark the video posted and remove only the publisher's queue record. */
export async function completePendingPostPublication(
  redis: WatchableRedisClient,
  claimed: PendingPost,
  processedAt: string,
): Promise<PendingPostCompletion> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID, REGISTRY_KEY);
  const [current, autoApproveJobId] = await Promise.all([
    getPendingPost(redis),
    redis.get(REDIS_KEY_PENDING_POST_JOB_ID),
  ]);
  if (!current || !hasCurrentLease(current, claimed, new Date()) || !current.postId || !current.commentId) {
    await transaction.unwatch();
    return { status: 'lost-claim' };
  }
  await transaction.multi();
  await transaction.hSet(REGISTRY_KEY, {
    [current.videoId]: JSON.stringify({
      title: current.videoTitle,
      status: 'posted',
      postId: current.postId,
      commentId: current.commentId,
      processedAt,
    } satisfies VideoRecord),
  });
  await transaction.del(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID);
  if ((await transaction.exec()).length === 0) return { status: 'conflict' };
  return {
    status: 'completed',
    ...(autoApproveJobId ? { autoApproveJobId } : {}),
  };
}

/** Remove the exact target's scheduler key before cancelling the external timer. */
export async function clearAutoApproveJobForPendingPost(
  redis: WatchableRedisClient,
  target: PendingPostTarget,
): Promise<string | undefined> {
  const transaction = await redis.watch(REDIS_KEY_PENDING_POST, REDIS_KEY_PENDING_POST_JOB_ID);
  const [pending, jobId] = await Promise.all([
    getPendingPost(redis),
    redis.get(REDIS_KEY_PENDING_POST_JOB_ID),
  ]);
  if (!pending || !matchesTarget(pending, target) || !jobId) {
    await transaction.unwatch();
    return undefined;
  }
  await transaction.multi();
  await transaction.del(REDIS_KEY_PENDING_POST_JOB_ID);
  if ((await transaction.exec()).length === 0) return undefined;
  return jobId;
}

/** Cancel an auto-approve job after pending state has been committed. */
export async function cancelAutoApproveJobById(scheduler: SchedulerClient, jobId?: string): Promise<void> {
  if (!jobId) return;
  try {
    await scheduler.cancelJob(jobId);
  } catch {
    // The timer can already be running; its target check makes that job a no-op.
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
  postId?: string;
}): Form {
  const target = JSON.stringify({ videoId: data.videoId, generatedAt: data.generatedAt });
  const hasLinkedPost = Boolean(data.postId);
  const fields: FormField[] = [
    {
      type: 'select',
      name: 'action',
      label: 'Action',
      options: hasLinkedPost
        ? [{ label: 'Publish', value: 'publish' }]
        : [
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
      disabled: hasLinkedPost,
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
    description: hasLinkedPost
      ? `Video: ${data.videoTitle}. Reddit already accepted the link post, so its title cannot change. Edit the discussion comment if needed, then publish to finish reconciliation.`
      : `Video: ${data.videoTitle}. Submit within about 10 minutes of opening this form — Reddit silently drops a stale submission, so reopen "Review pending post" and try again if nothing happens after you submit.`,
    fields,
    acceptLabel: hasLinkedPost ? 'Finish publishing' : 'Submit',
    cancelLabel: 'Close',
  };
}
