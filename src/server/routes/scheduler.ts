import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { redis, settings } from '@devvit/web/server';

export const scheduler = new Hono();

/**
 * Minimal stand-in: proves the declared `check_new_episodes` task endpoint is
 * reachable (by the cron carried over from the Blocks install, or by the
 * manual "[Trial] Check for new videos" menu item), and that the server can
 * still read the settings and Redis state the real handler depends on. Not a
 * full port of src/main.ts's check_new_episodes — this ticket is about
 * platform continuity, not feature parity.
 */
scheduler.post('/check-new-episodes', async (c) => {
  const request = await c.req.json<TaskRequest>();
  const [playlistId, hLen] = await Promise.all([
    settings.get('youtubePlaylistId'),
    redis.hLen('video_registry').catch(() => -1),
  ]);
  console.log(
    `[trial] check_new_episodes fired — data=${JSON.stringify(request.data)} youtubePlaylistId=${playlistId} video_registry hLen=${hLen}`
  );
  return c.json<TaskResponse>({}, 200);
});

scheduler.post('/post-pending-episode', async (c) => {
  const request = await c.req.json<TaskRequest>();
  console.log(`[trial] post_pending_episode fired — data=${JSON.stringify(request.data)}`);
  return c.json<TaskResponse>({}, 200);
});

scheduler.post('/regenerate-discussion', async (c) => {
  const request = await c.req.json<TaskRequest>();
  console.log(`[trial] regenerate_discussion fired — data=${JSON.stringify(request.data)}`);
  return c.json<TaskResponse>({}, 200);
});
