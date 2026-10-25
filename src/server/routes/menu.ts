import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { context, redis, settings, scheduler as schedulerClient } from '@devvit/web/server';
import { listAllJobsForDebug, listUserJobsForDebug } from '../checkerSchedule.js';

export const menu = new Hono();

const REDIS_KEYS_TO_DUMP = [
  'google_api_key',
  'video_registry',
  'pending_post',
  'pending_post_job_id',
  'last_episode_sticky_slot',
  'gemini_model',
  'gemini_thinking_level',
  'episode_checker_job_id',
  'episode_checker_verified_at',
];

/** Checklist item: confirm Redis key survival + setting values after upgrade. */
menu.post('/debug-state', async (c) => {
  const [settingValues, redisValues, hLen, allJobs, userJobs] = await Promise.all([
    settings.getAll(),
    Promise.all(REDIS_KEYS_TO_DUMP.map(async (k) => [k, await redis.get(k)] as const)),
    redis.hLen('video_registry').catch(() => -1),
    listAllJobsForDebug(),
    listUserJobsForDebug(),
  ]);
  console.log('[trial] settings:', JSON.stringify(settingValues));
  console.log('[trial] redis:', JSON.stringify(Object.fromEntries(redisValues)));
  console.log(`[trial] video_registry hLen: ${hLen}`);
  console.log(`[trial] listJobs() (all managers): ${JSON.stringify(allJobs)}`);
  console.log(`[trial] listJobs([USER]): ${JSON.stringify(userJobs)}`);
  return c.json<UiResponse>(
    {
      showToast: `Logged ${Object.keys(settingValues).length} settings, ${hLen} registry entries, ${allJobs.length} jobs (${userJobs.length} USER). See devvit logs.`,
    },
    200
  );
});

/** Checklist item: does a UiResponse with both showToast and showForm show both? */
menu.post('/toast-and-form', async (c) => {
  return c.json<UiResponse>(
    {
      showToast: 'This toast and the form below were returned together.',
      showForm: {
        name: 'toastAndForm',
        form: {
          title: 'Toast + form combo',
          fields: [{ name: 'note', label: 'Note', type: 'string', defaultValue: 'toast+form test' }],
        },
      },
    },
    200
  );
});

/** Checklist item: fire check_new_episodes now (proves the task endpoint is reachable). */
menu.post('/check-now', async (c) => {
  const jobId = await schedulerClient.runJob({
    name: 'check_new_episodes',
    runAt: new Date(),
    data: { manual: true, triggeredBy: context.username ?? null },
  });
  console.log(`[trial] Manually queued check_new_episodes — job ID: ${jobId}`);
  return c.json<UiResponse>({ showToast: 'Queued check_new_episodes; see devvit logs.' }, 200);
});

/** Checklist item: does a disabled field's value arrive on submit? */
menu.post('/disabled-field-form', async (c) => {
  await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'disabledField',
        form: {
          title: 'Disabled field test',
          fields: [
            { name: 'free', label: 'Editable', type: 'string', defaultValue: 'edit me' },
            { name: 'locked', label: 'Disabled (should arrive as "locked value")', type: 'string', defaultValue: 'locked value', disabled: true },
          ],
        },
      },
    },
    200
  );
});

/** Checklist item: is context.postId set on a post-menu form submit? */
menu.post('/post-id-form', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  console.log(`[trial] post-menu press — request.targetId=${request.targetId}, context.postId=${context.postId}`);
  return c.json<UiResponse>(
    {
      showForm: {
        name: 'postIdForm',
        form: {
          title: 'postId test',
          description: `At menu-press: context.postId=${context.postId ?? '(unset)'}, request.targetId=${request.targetId}`,
          fields: [{ name: 'noop', label: 'Press submit', type: 'boolean', defaultValue: true }],
        },
      },
    },
    200
  );
});
