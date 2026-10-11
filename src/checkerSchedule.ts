/**
 * Keeps the recurring `check_new_episodes` cron job alive.
 *
 * Blocks apps cannot declare a cron in devvit.json (that needs a server
 * entry point), so the job is created at runtime. AppInstall/AppUpgrade alone
 * proved unreliable — an install can end up with no job and no log — so the
 * app also re-verifies the job on mod actions and subreddit activity.
 */

export const CHECKER_JOB_NAME = 'check_new_episodes';
export const CHECKER_CRON = '*/30 * * * *';

const REDIS_KEY_JOB_ID = 'episode_checker_job_id';
const REDIS_KEY_VERIFIED_AT = 'episode_checker_verified_at';

/** Re-verify at most this often; matches the cron interval. */
const VERIFY_INTERVAL_MS = 30 * 60 * 1000;

type ListedJob = { id: string; name: string; cron?: string };

type ScheduleContext = {
  redis: {
    get: (key: string) => Promise<string | undefined>;
    set: (key: string, value: string) => Promise<unknown>;
  };
  scheduler: {
    listJobs: () => Promise<ListedJob[]>;
    runJob: (job: { name: string; cron: string }) => Promise<string>;
    cancelJob: (jobId: string) => Promise<void>;
  };
};

/**
 * Make sure exactly one `check_new_episodes` cron job exists.
 *
 * - `mode: 'reset'` (install/upgrade): cancel every existing checker cron and
 *   schedule a fresh one, so a job left over from an older version is replaced.
 * - `mode: 'heal'` (everything else): throttled to once per interval; schedules
 *   the job only if missing and cancels duplicates left by concurrent heals.
 *
 * Never throws: scheduling problems are logged so callers (menus, triggers)
 * keep working.
 */
export async function ensureCheckerScheduled(
  context: ScheduleContext,
  mode: 'reset' | 'heal',
): Promise<void> {
  const { redis, scheduler } = context;
  try {
    const now = Date.now();
    if (mode === 'heal') {
      const verifiedAt = Number(await redis.get(REDIS_KEY_VERIFIED_AT));
      if (verifiedAt && now - verifiedAt < VERIFY_INTERVAL_MS) {
        return;
      }
    }

    const checkers = (await scheduler.listJobs()).filter(
      (job) => job.name === CHECKER_JOB_NAME && job.cron !== undefined,
    );
    const toCancel = mode === 'reset' ? checkers : checkers.slice(1);
    for (const job of toCancel) {
      try { await scheduler.cancelJob(job.id); } catch { /* already gone */ }
    }

    const kept = mode === 'reset' ? undefined : checkers[0];
    if (kept) {
      await redis.set(REDIS_KEY_JOB_ID, kept.id);
    } else {
      const jobId = await scheduler.runJob({ name: CHECKER_JOB_NAME, cron: CHECKER_CRON });
      await redis.set(REDIS_KEY_JOB_ID, jobId);
      console.log(`[bot] Scheduled video checker (${mode}) — job ID: ${jobId}`);
    }
    if (toCancel.length > 0) {
      console.log(`[bot] Cancelled ${toCancel.length} stale/duplicate video checker job(s)`);
    }
    await redis.set(REDIS_KEY_VERIFIED_AT, String(now));
  } catch (err) {
    console.error(`[bot] Failed to verify video checker schedule: ${err}`);
  }
}
