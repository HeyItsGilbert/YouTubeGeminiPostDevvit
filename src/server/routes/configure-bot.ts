/**
 * "Configure bot" — subreddit mod menu item + its two-step form chain
 * (API key / pin slot / model, then an optional thinking-level step).
 * Decision and form-building logic live in ../configureBot.ts so they're
 * unit-testable without the Devvit SDK; this module only wires them to the
 * live `redis`/`scheduler` clients and the HTTP contract Devvit Web expects.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context, redis, scheduler } from '@devvit/web/server';
import { ensureCheckerScheduled } from '../checkerSchedule.js';
import {
  CONFIGURE_BOT_DRAFT_EXPIRY_MS,
  REDIS_KEY_CONFIGURE_BOT_REVISION,
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
  const draftKey = configureBotDraftKey(context.userId);
  const revision = randomUUID();
  const transaction = await redis.watch(draftKey);

  await transaction.multi();
  if (decision.apiKeyToSet) {
    await transaction.set(REDIS_KEY_GOOGLE_API_KEY, decision.apiKeyToSet);
  }
  await transaction.set(REDIS_KEY_STICKY_SLOT, decision.slot);
  if (decision.storedModel) {
    await transaction.set(REDIS_KEY_GEMINI_MODEL, decision.storedModel);
  } else {
    await transaction.del(REDIS_KEY_GEMINI_MODEL);
  }
  if (decision.clearThinkingLevel) {
    await transaction.del(REDIS_KEY_THINKING_LEVEL);
  }
  await transaction.set(REDIS_KEY_CONFIGURE_BOT_REVISION, revision);
  if (decision.openThinkingForm) {
    await transaction.set(draftKey, JSON.stringify({ model: decision.model, revision }), {
      expiration: new Date(Date.now() + CONFIGURE_BOT_DRAFT_EXPIRY_MS),
    });
  } else {
    await transaction.del(draftKey);
  }

  if ((await transaction.exec()).length === 0) {
    return c.json<UiResponse>({
      showToast: 'Configuration changed while this form was submitted. Open "Configure bot" and try again.',
    });
  }

  if (!decision.openThinkingForm) {
    return c.json<UiResponse>({ showToast: decision.toast });
  }

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
  const transaction = await redis.watch(draftKey, REDIS_KEY_CONFIGURE_BOT_REVISION);
  const [draftJson, revision] = await Promise.all([redis.get(draftKey), redis.get(REDIS_KEY_CONFIGURE_BOT_REVISION)]);

  if (!draftJson) {
    await transaction.unwatch();
    return c.json<UiResponse>({
      showToast: 'This form expired. Open "Configure bot" again to choose a thinking level.',
    });
  }

  const draft = JSON.parse(draftJson) as { model: string; revision?: string };
  if (!draft.revision || draft.revision !== revision) {
    await transaction.unwatch();
    return c.json<UiResponse>({
      showToast: 'Configuration changed while this form was open. Open "Configure bot" and try again.',
    });
  }

  const decision = decideThinkingLevelSubmission(draft.model, values.thinkingLevel);
  await transaction.multi();
  if (decision.level) {
    await transaction.set(REDIS_KEY_THINKING_LEVEL, decision.level);
  } else {
    await transaction.del(REDIS_KEY_THINKING_LEVEL);
  }
  await transaction.del(draftKey);

  if ((await transaction.exec()).length === 0) {
    return c.json<UiResponse>({
      showToast: 'Configuration changed while this form was submitted. Open "Configure bot" and try again.',
    });
  }

  return c.json<UiResponse>({ showToast: decision.toast });
});
