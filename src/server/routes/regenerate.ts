/**
 * "Regenerate discussion" — rewrites an existing Episode Post's discussion
 * comment with fresh Gemini output, under an optional one-off system
 * prompt/model/thinking-level override. Does not resubmit the post,
 * reapply flair, or touch the pin.
 *
 * Three endpoints form the menu → form → form → job chain:
 *   - `/menu/regenerate-discussion`   menu press on an Episode Post
 *   - `/form/regenerate-step1`        prompt + optional model/toggle
 *   - `/form/regenerate-step2`        thinking level (only if step 1's toggle was on)
 * plus the `regenerate_discussion` scheduler task that does the actual work.
 *
 * Step 1's submit handler reads the target post from `context.postId`. From
 * step 2 onward the chain can no longer rely on request context alone, so
 * step 1 persists everything step 2 needs — including the post ID — in a
 * TTL'd Redis draft keyed by user ID (see `../regenerateDraft.ts`).
 */

import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { context, reddit, redis, scheduler, settings } from '@devvit/web/server';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';

import { ensureCheckerScheduled } from '../checkerSchedule.js';
import { fetchYouTubeVideoById } from '../episodeChecker.js';
import { generateEpisodePost } from '../llmClient.js';
import { REDIS_KEY_GOOGLE_API_KEY, getGeminiChoice } from '../configureBot.js';
import { sendFailureNotification } from '../notifications.js';
import { updateEpisodePost, type CommentId } from '../postManager.js';
import { findVideoByPostId, isRegeneratable } from '../videoRegistry.js';
import { assemblePostBody, applyPlaceholders } from '../../postUtils.js';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS, resolveThinkingLevel, thinkingLevelsFor } from '../../geminiModels.js';
import {
  MODEL_DEFAULT_THINKING_LEVEL,
  buildStep1Form,
  buildStep2Form,
  type Step1FormValues,
  type Step2FormValues,
} from '../regenerateForms.js';
import type { ThinkingLevel } from '../../types.js';
import { clearRegenerateDraft, loadRegenerateDraft, saveRegenerateDraft, type RegenerateDraft } from '../regenerateDraft.js';

export const regenerate = new Hono();

const NOT_REGENERATABLE_TOAST =
  "This post isn't an Episode Post with a tracked discussion comment, so there's nothing to regenerate.";

/** Data passed to the `regenerate_discussion` scheduler task. */
type RegenerateJobData = {
  videoId: string;
  commentId: string;
  systemPrompt: string;
  model: string;
  thinkingLevel: ThinkingLevel | null;
  triggeredBy: string | null;
};

// ---------------------------------------------------------------------------
// 1. Menu item — press "Regenerate discussion" on a post
// ---------------------------------------------------------------------------

regenerate.post('/menu/regenerate-discussion', async (c) => {
  const { targetId: postId } = await c.req.json<MenuItemRequest>();
  await ensureCheckerScheduled({ redis, scheduler }, 'heal');

  const found = await findVideoByPostId(redis, postId);
  if (!isRegeneratable(found?.record)) {
    return c.json<UiResponse>({ showToast: NOT_REGENERATABLE_TOAST });
  }

  const [systemPrompt, gemini] = await Promise.all([
    settings.get<string>('systemPrompt'),
    getGeminiChoice(redis),
  ]);
  if (!systemPrompt) {
    return c.json<UiResponse>({
      showToast: 'No System Prompt is set. Add one in the app settings (Mod Tools → Installed Apps) first.',
    });
  }

  return c.json<UiResponse>({
    showForm: {
      name: 'regenerateStep1Form',
      form: buildStep1Form({ systemPrompt, models: GEMINI_MODELS, selectedModel: gemini.model }),
    },
  });
});

// ---------------------------------------------------------------------------
// 2. Step 1 submit — prompt, optional model override, optional toggle
// ---------------------------------------------------------------------------

regenerate.post('/form/regenerate-step1', async (c) => {
  const values = await c.req.json<Step1FormValues>();
  const postId = context.postId;
  const userId = context.userId;

  if (!postId || !userId) {
    return c.json<UiResponse>({
      showToast: 'Could not tell which post to regenerate — please try again from the post menu.',
    });
  }

  const found = await findVideoByPostId(redis, postId);
  if (!isRegeneratable(found?.record)) {
    return c.json<UiResponse>({ showToast: NOT_REGENERATABLE_TOAST });
  }

  const model = values.model[0] ?? DEFAULT_GEMINI_MODEL;
  const systemPrompt = values.systemPrompt;
  const triggeredBy = context.username ?? null;

  if (values.chooseThinkingLevel) {
    const draft: RegenerateDraft = {
      postId,
      videoId: found.videoId,
      commentId: found.record.commentId,
      systemPrompt,
      model,
      triggeredBy,
    };
    await saveRegenerateDraft(redis, userId, draft);
    return c.json<UiResponse>({
      showForm: {
        name: 'regenerateStep2Form',
        form: buildStep2Form({ levels: thinkingLevelsFor(model) }),
      },
    });
  }

  const gemini = await getGeminiChoice(redis);
  const thinkingLevel = resolveThinkingLevel(model, gemini.thinkingLevel) ?? null;
  await scheduler.runJob({
    name: 'regenerate_discussion',
    runAt: new Date(),
    data: {
      videoId: found.videoId,
      commentId: found.record.commentId,
      systemPrompt,
      model,
      thinkingLevel,
      triggeredBy,
    } satisfies RegenerateJobData,
  });

  return c.json<UiResponse>({
    showToast: 'Regenerating the discussion comment — this can take a few minutes. Try again if nothing changes.',
  });
});

// ---------------------------------------------------------------------------
// 3. Step 2 submit — thinking level (only reached if step 1's toggle was on)
// ---------------------------------------------------------------------------

regenerate.post('/form/regenerate-step2', async (c) => {
  const values = await c.req.json<Step2FormValues>();
  const userId = context.userId;

  if (!userId) {
    return c.json<UiResponse>({
      showToast: 'Could not tell who submitted this form — please try again from the post menu.',
    });
  }

  const draft = await loadRegenerateDraft(redis, userId);
  await clearRegenerateDraft(redis, userId);
  if (!draft) {
    return c.json<UiResponse>({
      showToast: 'This regeneration request expired — start over from the post menu.',
    });
  }

  const chosenLevel = values.thinkingLevel[0] ?? MODEL_DEFAULT_THINKING_LEVEL;
  const thinkingLevel =
    (chosenLevel === MODEL_DEFAULT_THINKING_LEVEL
      ? resolveThinkingLevel(draft.model, (await getGeminiChoice(redis)).thinkingLevel)
      : resolveThinkingLevel(draft.model, chosenLevel)) ?? null;

  await scheduler.runJob({
    name: 'regenerate_discussion',
    runAt: new Date(),
    data: {
      videoId: draft.videoId,
      commentId: draft.commentId,
      systemPrompt: draft.systemPrompt,
      model: draft.model,
      thinkingLevel,
      triggeredBy: draft.triggeredBy ?? null,
    } satisfies RegenerateJobData,
  });

  return c.json<UiResponse>({
    showToast: 'Regenerating the discussion comment — this can take a few minutes. Try again if nothing changes.',
  });
});

// ---------------------------------------------------------------------------
// 4. Scheduler task — re-run Gemini and edit the discussion comment
// ---------------------------------------------------------------------------

regenerate.post('/scheduler/regenerate-discussion', async (c) => {
  const event = await c.req.json<TaskRequest<RegenerateJobData>>();
  const { videoId, commentId, systemPrompt, model, thinkingLevel, triggeredBy } = event.data;

  try {
    const [googleApiKey, prependText, appendText] = await Promise.all([
      redis.get(REDIS_KEY_GOOGLE_API_KEY),
      settings.get<string>('prependText').then((v) => v || ''),
      settings.get<string>('appendText').then((v) => v || ''),
    ]);
    if (!googleApiKey) {
      throw new Error('No Google API key is saved. Add one with "Configure bot" in the subreddit\'s "…" menu.');
    }

    const episode = await fetchYouTubeVideoById(googleApiKey, videoId);
    if (!episode) {
      throw new Error(`YouTube video ${videoId} could not be found (it may have been deleted or made private).`);
    }

    console.log(`[bot] Regenerating discussion for "${episode.title}" (model: ${model})`);
    const { body: rawBody } = await generateEpisodePost(
      googleApiKey,
      episode,
      systemPrompt,
      model,
      thinkingLevel ?? undefined,
    );
    const body = assemblePostBody(
      applyPlaceholders(prependText, episode),
      rawBody,
      applyPlaceholders(appendText, episode),
    );

    await updateEpisodePost(reddit, commentId as CommentId, body);
    console.log(`[bot] Regenerated discussion comment ${commentId}`);
  } catch (err) {
    console.error(`[bot] Regenerate discussion failed: ${err}`);
    await sendFailureNotification(
      reddit,
      [],
      triggeredBy,
      'Regenerate discussion failed',
      `Regenerating the discussion comment on r/${context.subredditName} failed with the following error:\n\n    ${err}\n\nPlease try again later, or report it at https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues.`,
    );
  }

  return c.json<TaskResponse>({}, 200);
});
