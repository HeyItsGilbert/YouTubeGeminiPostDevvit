/**
 * `post_pending_episode` scheduler task — publishes a mod-approved or
 * auto-approved pending post. Declared here so Devvit Web's "every job must
 * be declared" requirement is satisfied; the "Review pending post" feature
 * that triggers this job (and its full publish/discard/reject logic) is
 * wired up in a later ticket.
 */

import { Hono } from 'hono';
import type { TaskResponse } from '@devvit/web/server';

export const pendingPost = new Hono();

pendingPost.post('/post-pending-episode', async (c) => {
  console.log('[bot] post_pending_episode: not yet implemented in this build.');
  return c.json<TaskResponse>({}, 200);
});
