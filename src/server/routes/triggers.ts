import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnAppUpgradeRequest,
  OnCommentSubmitRequest,
  OnPostSubmitRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { redis } from '@devvit/web/server';
import { ensureCheckerScheduled } from '../checkerSchedule.js';

export const triggers = new Hono();

const REDIS_KEY_SCHEMA_MARKER = 'trial_web_migration_marker';

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log(`[trial] AppInstall on r/${input.subreddit?.name}`);
  await ensureCheckerScheduled('reset');
  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-app-upgrade', async (c) => {
  const input = await c.req.json<OnAppUpgradeRequest>();
  console.log(`[trial] AppUpgrade on r/${input.subreddit?.name} — installer: ${input.installer?.name ?? 'unknown'}`);
  // Idempotent marker: payload carries no from/to version (per upgrade-continuity research).
  await redis.set(REDIS_KEY_SCHEMA_MARKER, JSON.stringify({ migratedAt: Date.now() }));
  await ensureCheckerScheduled('reset');
  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-post-submit', async (c) => {
  await c.req.json<OnPostSubmitRequest>();
  await ensureCheckerScheduled('heal');
  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-comment-submit', async (c) => {
  await c.req.json<OnCommentSubmitRequest>();
  await ensureCheckerScheduled('heal');
  return c.json<TriggerResponse>({}, 200);
});
