import { describe, expect, it } from 'vitest';
import { CHECKER_CRON, CHECKER_JOB_NAME, ensureCheckerScheduled } from './checkerSchedule.js';

type FakeJob = { id: string; name: string; cron?: string };

/** Map-backed fake Redis + array-backed fake scheduler — no Devvit SDK mocking. */
function createFakeContext(initialJobs: FakeJob[] = [], now = 1_000_000) {
  const redisStore = new Map<string, string>();
  const jobs = new Map<string, FakeJob>(initialJobs.map((j) => [j.id, j]));
  const cancelledIds: string[] = [];
  const listJobsCalls: (number[] | undefined)[] = [];
  let nextJobId = initialJobs.length + 1;

  const context = {
    redis: {
      async get(key: string): Promise<string | undefined> {
        return redisStore.get(key);
      },
      async set(key: string, value: string): Promise<unknown> {
        redisStore.set(key, value);
        return 'OK';
      },
    },
    scheduler: {
      async listJobs(managers?: number[]): Promise<FakeJob[]> {
        listJobsCalls.push(managers);
        return [...jobs.values()];
      },
      async runJob(job: { name: string; cron: string }): Promise<string> {
        const id = `job-${nextJobId++}`;
        jobs.set(id, { id, name: job.name, cron: job.cron });
        return id;
      },
      async cancelJob(jobId: string): Promise<void> {
        jobs.delete(jobId);
        cancelledIds.push(jobId);
      },
    },
  };

  return { context, redisStore, jobs, cancelledIds, listJobsCalls, now };
}

describe('ensureCheckerScheduled — reset mode', () => {
  it('schedules a fresh job when none exists', async () => {
    const { context, jobs } = createFakeContext();
    await ensureCheckerScheduled(context, 'reset');
    const checkers = [...jobs.values()].filter((j) => j.name === CHECKER_JOB_NAME);
    expect(checkers).toHaveLength(1);
    expect(checkers[0]?.cron).toBe(CHECKER_CRON);
  });

  it('scopes listJobs to USER-managed jobs only (not devvit.json-declared tasks)', async () => {
    const { context, listJobsCalls } = createFakeContext();
    await ensureCheckerScheduled(context, 'reset');
    expect(listJobsCalls).toHaveLength(1);
    expect(listJobsCalls[0]).toEqual([2]); // ScheduledActionManager.USER
  });

  it('cancels every existing checker job and schedules one fresh job', async () => {
    const { context, jobs, cancelledIds } = createFakeContext([
      { id: 'old-1', name: CHECKER_JOB_NAME, cron: CHECKER_CRON },
      { id: 'old-2', name: CHECKER_JOB_NAME, cron: CHECKER_CRON },
    ]);
    await ensureCheckerScheduled(context, 'reset');
    expect(cancelledIds.sort()).toEqual(['old-1', 'old-2']);
    const checkers = [...jobs.values()].filter((j) => j.name === CHECKER_JOB_NAME);
    expect(checkers).toHaveLength(1);
    expect(checkers[0]?.id).not.toBe('old-1');
    expect(checkers[0]?.id).not.toBe('old-2');
  });

  it('ignores jobs with other names', async () => {
    const { context, jobs } = createFakeContext([
      { id: 'other-1', name: 'post_pending_episode', cron: '0 * * * *' },
    ]);
    await ensureCheckerScheduled(context, 'reset');
    expect(jobs.has('other-1')).toBe(true);
    const checkers = [...jobs.values()].filter((j) => j.name === CHECKER_JOB_NAME);
    expect(checkers).toHaveLength(1);
  });

  it('is not throttled — runs even if recently verified', async () => {
    const { context, redisStore, jobs } = createFakeContext([
      { id: 'old-1', name: CHECKER_JOB_NAME, cron: CHECKER_CRON },
    ]);
    redisStore.set('episode_checker_verified_at', String(Date.now()));
    await ensureCheckerScheduled(context, 'reset');
    expect(jobs.has('old-1')).toBe(false);
    const checkers = [...jobs.values()].filter((j) => j.name === CHECKER_JOB_NAME);
    expect(checkers).toHaveLength(1);
  });
});

describe('ensureCheckerScheduled — heal mode', () => {
  it('schedules a job when none exists', async () => {
    const { context, jobs } = createFakeContext();
    await ensureCheckerScheduled(context, 'heal');
    const checkers = [...jobs.values()].filter((j) => j.name === CHECKER_JOB_NAME);
    expect(checkers).toHaveLength(1);
  });

  it('leaves a single existing job untouched', async () => {
    const { context, jobs, cancelledIds } = createFakeContext([
      { id: 'existing', name: CHECKER_JOB_NAME, cron: CHECKER_CRON },
    ]);
    await ensureCheckerScheduled(context, 'heal');
    expect(cancelledIds).toHaveLength(0);
    expect(jobs.has('existing')).toBe(true);
    expect(jobs.size).toBe(1);
  });

  it('cancels duplicate jobs, keeping exactly one', async () => {
    const { context, jobs, cancelledIds } = createFakeContext([
      { id: 'dup-1', name: CHECKER_JOB_NAME, cron: CHECKER_CRON },
      { id: 'dup-2', name: CHECKER_JOB_NAME, cron: CHECKER_CRON },
      { id: 'dup-3', name: CHECKER_JOB_NAME, cron: CHECKER_CRON },
    ]);
    await ensureCheckerScheduled(context, 'heal');
    const checkers = [...jobs.values()].filter((j) => j.name === CHECKER_JOB_NAME);
    expect(checkers).toHaveLength(1);
    expect(checkers[0]?.id).toBe('dup-1');
    expect(cancelledIds.sort()).toEqual(['dup-2', 'dup-3']);
  });

  it('is throttled: does nothing when verified within the last 30 minutes', async () => {
    const { context, redisStore, jobs } = createFakeContext();
    redisStore.set('episode_checker_verified_at', String(Date.now() - 10 * 60 * 1000));
    await ensureCheckerScheduled(context, 'heal');
    expect(jobs.size).toBe(0);
  });

  it('re-verifies once the throttle window has elapsed', async () => {
    const { context, redisStore, jobs } = createFakeContext();
    redisStore.set('episode_checker_verified_at', String(Date.now() - 31 * 60 * 1000));
    await ensureCheckerScheduled(context, 'heal');
    const checkers = [...jobs.values()].filter((j) => j.name === CHECKER_JOB_NAME);
    expect(checkers).toHaveLength(1);
  });

  it('updates the verified-at timestamp after running', async () => {
    const { context, redisStore } = createFakeContext();
    const before = Date.now();
    await ensureCheckerScheduled(context, 'heal');
    const verifiedAt = Number(redisStore.get('episode_checker_verified_at'));
    expect(verifiedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('ensureCheckerScheduled — error handling', () => {
  it('never throws, even when the scheduler client fails', async () => {
    const context = {
      redis: {
        get: async () => undefined,
        set: async () => 'OK',
      },
      scheduler: {
        listJobs: async () => {
          throw new Error('scheduler unavailable');
        },
        runJob: async () => 'unused',
        cancelJob: async () => {},
      },
    };
    await expect(ensureCheckerScheduled(context, 'reset')).resolves.toBeUndefined();
  });
});
