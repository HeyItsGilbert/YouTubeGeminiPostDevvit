/**
 * [TRIAL] Devvit Web port of src/checkerSchedule.ts for the upgrade-continuity
 * experiment (ticket #37). Per the decision in "Can ensureCheckerScheduled be
 * retired in favour of a declared cron?" (#34): keep the runtime USER checker
 * with reset/heal, filtered to USER jobs; `check_new_episodes` is declared in
 * devvit.json without a `cron`.
 */
import { redis, scheduler, ScheduledActionManager } from '@devvit/web/server';

export const CHECKER_JOB_NAME = 'check_new_episodes';
export const CHECKER_CRON = '*/30 * * * *';

const REDIS_KEY_JOB_ID = 'episode_checker_job_id';
const REDIS_KEY_VERIFIED_AT = 'episode_checker_verified_at';

const VERIFY_INTERVAL_MS = 30 * 60 * 1000;

export async function ensureCheckerScheduled(mode: 'reset' | 'heal'): Promise<void> {
  try {
    const now = Date.now();
    if (mode === 'heal') {
      const verifiedAt = Number(await redis.get(REDIS_KEY_VERIFIED_AT));
      if (verifiedAt && now - verifiedAt < VERIFY_INTERVAL_MS) {
        return;
      }
    }

    const allJobs = await scheduler.listJobs([ScheduledActionManager.USER]);
    const checkers = allJobs.filter(
      (job): job is typeof job & { cron: string } =>
        job.name === CHECKER_JOB_NAME && 'cron' in job && job.cron !== undefined
    );
    const toCancel = mode === 'reset' ? checkers : checkers.slice(1);
    for (const job of toCancel) {
      try {
        await scheduler.cancelJob(job.id);
      } catch {
        /* already gone */
      }
    }

    const kept = mode === 'reset' ? undefined : checkers[0];
    if (kept) {
      await redis.set(REDIS_KEY_JOB_ID, kept.id);
    } else {
      const jobId = await scheduler.runJob({ name: CHECKER_JOB_NAME, cron: CHECKER_CRON });
      await redis.set(REDIS_KEY_JOB_ID, jobId);
      console.log(`[trial] Scheduled video checker (${mode}) — job ID: ${jobId}`);
    }
    if (toCancel.length > 0) {
      console.log(`[trial] Cancelled ${toCancel.length} stale/duplicate video checker job(s)`);
    }
    await redis.set(REDIS_KEY_VERIFIED_AT, String(now));
  } catch (err) {
    console.error(`[trial] Failed to verify video checker schedule: ${err}`);
  }
}

/** All scheduled jobs (any manager) — for the debug menu item. */
export async function listAllJobsForDebug() {
  return scheduler.listJobs();
}

/** Only USER-manager jobs — what ensureCheckerScheduled actually filters on. */
export async function listUserJobsForDebug() {
  return scheduler.listJobs([ScheduledActionManager.USER]);
}
