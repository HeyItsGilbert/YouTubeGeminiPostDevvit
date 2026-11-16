import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_CLAIM_KEY,
  buildPlaytestCheckForm,
  claimChecker,
  isPlaytestInstall,
  releaseCheckerClaim,
  scheduleManualCheck,
} from './manualCheck.js';

describe('isPlaytestInstall', () => {
  it('recognises prerelease app versions with a fourth segment', () => {
    expect(isPlaytestInstall('1.0.0.1')).toBe(true);
    expect(isPlaytestInstall('1.0.0')).toBe(false);
  });
});

describe('buildPlaytestCheckForm', () => {
  it('offers the force-repost testing tool', () => {
    expect(buildPlaytestCheckForm().fields).toEqual([
      expect.objectContaining({ name: 'forceRepost', defaultValue: false }),
    ]);
  });
});

describe('scheduleManualCheck', () => {
  it('carries the triggering moderator in the check job data', async () => {
    const redis = { set: vi.fn().mockResolvedValue(undefined) };
    const scheduler = { runJob: vi.fn().mockResolvedValue(undefined) };
    await scheduleManualCheck({ reddit: { getCurrentUsername: vi.fn().mockResolvedValue('mod') }, redis, scheduler }, true);

    expect(redis.set).toHaveBeenCalledWith('check_triggered_by', 'mod');
    expect(scheduler.runJob).toHaveBeenCalledWith(expect.objectContaining({
      name: 'check_new_episodes',
      data: { manual: true, forceRepost: true, triggeredBy: 'mod' },
    }));
  });
});

describe('checker claim', () => {
  it('acquires one expiring installation-wide claim and releases only its owner token', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: async (key: string, value: string, options?: { nx?: boolean }) => {
        if (options?.nx && store.has(key)) return undefined;
        store.set(key, value);
        return 'OK';
      },
      get: async (key: string) => store.get(key),
      del: async (key: string) => store.delete(key),
      watch: async (...keys: string[]) => {
        const watched = new Map(keys.map((key) => [key, store.get(key)]));
        let deleteKey: string | undefined;
        return {
          multi: async () => {},
          del: async (key: string) => { deleteKey = key; },
          exec: async () => {
            if ([...watched].some(([key, value]) => store.get(key) !== value)) return [];
            if (deleteKey) store.delete(deleteKey);
            return ['OK'];
          },
          unwatch: async () => {},
        };
      },
    };
    const first = await claimChecker(redis);
    expect(first).toBeTruthy();
    expect(await claimChecker(redis)).toBeNull();
    await releaseCheckerClaim(redis, 'not-the-owner');
    expect(store.get(CHECK_CLAIM_KEY)).toBe(first);
    await releaseCheckerClaim(redis, first!);
    expect(store.has(CHECK_CLAIM_KEY)).toBe(false);
  });
});
