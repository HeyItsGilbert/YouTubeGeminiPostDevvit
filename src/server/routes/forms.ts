import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';

export const forms = new Hono();

forms.post('/toast-and-form-submit', async (c) => {
  const values = await c.req.json();
  console.log('[trial] toast-and-form submit values:', JSON.stringify(values));
  return c.json<UiResponse>({ showToast: 'toast-and-form submitted.' }, 200);
});

forms.post('/disabled-field-submit', async (c) => {
  const values = await c.req.json<{ free?: string; locked?: string }>();
  console.log('[trial] disabled-field submit values:', JSON.stringify(values));
  return c.json<UiResponse>(
    { showToast: `free="${values.free}" locked="${values.locked ?? '(absent)'}" — see devvit logs too.` },
    200
  );
});

forms.post('/post-id-submit', async (c) => {
  await c.req.json();
  console.log(`[trial] post-id-form submit — context.postId=${context.postId}, context.userId=${context.userId}`);
  return c.json<UiResponse>({ showToast: `On submit: context.postId=${context.postId ?? '(unset)'}` }, 200);
});
