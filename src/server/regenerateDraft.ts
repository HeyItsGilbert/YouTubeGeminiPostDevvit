/**
 * "Regenerate discussion" step 1's answers, carried to step 2 of the form
 * chain. A form submit handler only receives its own form's fields — the
 * target post, the chosen model, and the prompt from step 1 would otherwise
 * be lost by the time step 2 submits — so step 1 stores them here, keyed by
 * the submitting user's ID, and step 2 reads (then deletes) them.
 */

export interface RegenerateDraft {
  /** Target post, carried through so step 2 doesn't depend on request context. */
  postId: string;
  videoId: string;
  commentId: string;
  systemPrompt: string;
  model: string;
  /** Username of the moderator who opened the form, for failure PMs. */
  triggeredBy: string | null;
}

type RedisClient = {
  set(key: string, value: string, options?: { expiration?: Date }): Promise<unknown>;
  get(key: string): Promise<string | undefined>;
  del(key: string): Promise<unknown>;
};

/** Long enough to outlast the ~10 minute menu-action window with margin, short enough not to leak stale drafts. */
const DRAFT_TTL_MS = 60 * 60 * 1000;

export function draftKey(userId: string): string {
  return `regenerate_draft:${userId}`;
}

export async function saveRegenerateDraft(
  redis: RedisClient,
  userId: string,
  draft: RegenerateDraft,
): Promise<void> {
  await redis.set(draftKey(userId), JSON.stringify(draft), {
    expiration: new Date(Date.now() + DRAFT_TTL_MS),
  });
}

/** Returns null if no draft is saved, it expired, or it's corrupt. */
export async function loadRegenerateDraft(
  redis: RedisClient,
  userId: string,
): Promise<RegenerateDraft | null> {
  const raw = await redis.get(draftKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RegenerateDraft;
  } catch {
    return null;
  }
}

export async function clearRegenerateDraft(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(draftKey(userId));
}
