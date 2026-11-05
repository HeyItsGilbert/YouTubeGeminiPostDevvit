/**
 * `regenerate_discussion` scheduler task — re-runs Gemini for an existing
 * Episode Post and edits its discussion comment. Declared here so Devvit
 * Web's "every job must be declared" requirement is satisfied; the
 * "Regenerate discussion" post menu feature that triggers this job (and its
 * full form-chain logic) is wired up in a later ticket.
 */

import { Hono } from 'hono';
import type { TaskResponse } from '@devvit/web/server';

export const regenerate = new Hono();

regenerate.post('/regenerate-discussion', async (c) => {
  console.log('[bot] regenerate_discussion: not yet implemented in this build.');
  return c.json<TaskResponse>({}, 200);
});
