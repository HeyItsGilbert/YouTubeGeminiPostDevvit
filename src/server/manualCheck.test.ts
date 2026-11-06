import { describe, expect, it, vi } from 'vitest';
import { buildPlaytestCheckForm, isPlaytestInstall, scheduleManualCheck } from './manualCheck.js';

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
  it('records the triggering moderator and schedules a manual check', async () => {
    const redis = { set: vi.fn().mockResolvedValue(undefined) };
    const scheduler = { runJob: vi.fn().mockResolvedValue(undefined) };
    await scheduleManualCheck({ reddit: { getCurrentUsername: vi.fn().mockResolvedValue('mod') }, redis, scheduler }, true);

    expect(redis.set).toHaveBeenCalledWith('check_triggered_by', 'mod');
    expect(scheduler.runJob).toHaveBeenCalledWith(expect.objectContaining({
      name: 'check_new_episodes',
      data: { manual: true, forceRepost: true },
    }));
  });
});
