import { describe, expect, it, vi } from 'vitest';


const ensureCheckerScheduled = vi.fn();
const migrateLegacyAutoApproveJob = vi.fn();
const redis = {};
const scheduler = {};

vi.mock('@devvit/web/server', () => ({ redis, scheduler }));
vi.mock('../checkerSchedule.js', () => ({ ensureCheckerScheduled }));
vi.mock('../pendingPost.js', () => ({ migrateLegacyAutoApproveJob }));
// Load after the singleton collaborators are mocked.
const { triggers } = await import('./triggers.js');
describe('app upgrade trigger', () => {
  it('migrates the outstanding legacy auto-approval timer before resetting the checker', async () => {
    await triggers.request('/on-app-upgrade', { method: 'POST' });

    expect(migrateLegacyAutoApproveJob).toHaveBeenCalledWith({ redis, scheduler });
    expect(ensureCheckerScheduled).toHaveBeenCalledWith({ redis, scheduler }, 'reset');
    expect(migrateLegacyAutoApproveJob.mock.invocationCallOrder[0]).toBeLessThan(
      ensureCheckerScheduled.mock.invocationCallOrder[0]!,
    );
  });
});
