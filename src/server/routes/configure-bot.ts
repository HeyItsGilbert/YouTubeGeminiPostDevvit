/**
 * "Configure bot" — subreddit mod menu item + its two-step form chain
 * (API key / pin slot / model, then an optional thinking-level step).
 * Decision and form-building logic live in ../configureBot.ts so they're
 * unit-testable without the Devvit SDK; this module only wires them to the
 * live `redis`/`scheduler` clients and the HTTP contract Devvit Web expects.
 */

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, redis, scheduler } from '@devvit/web/server';
import { ensureCheckerScheduled } from '../checkerSchedule.js';
import {
  CONFIGURE_BOT_DRAFT_EXPIRY_MS,
  REDIS_KEY_GEMINI_MODEL,
  REDIS_KEY_GOOGLE_API_KEY,
  REDIS_KEY_STICKY_SLOT,
  REDIS_KEY_THINKING_LEVEL,
  buildConfigureBotForm,
  buildThinkingLevelForm,
  configureBotDraftKey,
  decideConfigureBotSubmission,
  decideThinkingLevelSubmission,
  getGeminiChoice,
  type ConfigureBotSubmission,
} from '../configureBot.js';

export const configureBot = new Hono();

type ThinkingLevelSubmission = { thinkingLevel?: string[] };

configureBot.post('/menu/configure-bot', async (c) => {
  await ensureCheckerScheduled({ redis, scheduler }, 'heal');

  const [apiKey, slotStr, gemini] = await Promise.all([
    redis.get(REDIS_KEY_GOOGLE_API_KEY),
    redis.get(REDIS_KEY_STICKY_SLOT),
    getGeminiChoice(redis),
  ]);

  return c.json<UiResponse>({
    showForm: {
      name: 'configureBot',
      form: buildConfigureBotForm({
        hasApiKey: Boolean(apiKey),
        currentSlot: slotStr === '2' ? 2 : 1,
        storedModel: gemini.isDefaultModel ? null : gemini.model,
        hasThinkingLevel: gemini.thinkingLevel !== undefined,
      }),
    },
  });
});

configureBot.post('/form/configure-bot', async (c) => {
  const values = await c.req.json<ConfigureBotSubmission>();
  const previous = await getGeminiChoice(redis);
  const decision = decideConfigureBotSubmission(values, previous);

  await Promise.all([
    decision.apiKeyToSet ? redis.set(REDIS_KEY_GOOGLE_API_KEY, decision.apiKeyToSet) : Promise.resolve(),
    redis.set(REDIS_KEY_STICKY_SLOT, decision.slot),
    decision.storedModel ? redis.set(REDIS_KEY_GEMINI_MODEL, decision.storedModel) : redis.del(REDIS_KEY_GEMINI_MODEL),
    decision.clearThinkingLevel ? redis.del(REDIS_KEY_THINKING_LEVEL) : Promise.resolve(),
  ]);

  if (!decision.openThinkingForm) {
    return c.json<UiResponse>({ showToast: decision.toast });
  }

  // Carry the model this step just resolved into step 2 — a form submit
  // endpoint only receives its own fields, so it can't ride along on the
  // showForm response itself.
  await redis.set(configureBotDraftKey(context.userId), JSON.stringify({ model: decision.model }), {
    expiration: new Date(Date.now() + CONFIGURE_BOT_DRAFT_EXPIRY_MS),
  });

  return c.json<UiResponse>({
    showForm: {
      name: 'configureBotThinkingLevel',
      form: buildThinkingLevelForm({ model: decision.model, thinkingLevel: decision.thinkingFormDefault }),
    },
  });
});

configureBot.post('/form/configure-bot-thinking-level', async (c) => {
  const values = await c.req.json<ThinkingLevelSubmission>();
  const draftKey = configureBotDraftKey(context.userId);
  const draftJson = await redis.get(draftKey);

  if (!draftJson) {
    return c.json<UiResponse>({
      showToast: 'This form expired. Open "Configure bot" again to choose a thinking level.',
    });
  }

  await redis.del(draftKey);
  const { model } = JSON.parse(draftJson) as { model: string };
  const decision = decideThinkingLevelSubmission(model, values.thinkingLevel);
  await (decision.level ? redis.set(REDIS_KEY_THINKING_LEVEL, decision.level) : redis.del(REDIS_KEY_THINKING_LEVEL));

  return c.json<UiResponse>({ showToast: decision.toast });
});
