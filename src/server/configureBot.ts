/**
 * "Configure bot" — Google API key, pin slot, and the Advanced (optional)
 * Gemini model + thinking-level override.
 *
 * Field/decision builders are pure and live here so they're testable without
 * the Devvit SDK, the same seam checkerSchedule.ts, videoRegistry.ts, and
 * postManager.ts use. The Hono route in routes/configure-bot.ts wires them
 * to the live `redis`/`scheduler` clients and to the two-step form chain.
 */

import type { Form, FormField } from '@devvit/web/shared';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
  describeModel,
  describeThinkingLevel,
  resolveThinkingLevel,
  thinkingLevelsFor,
} from '../geminiModels.js';
import type { ThinkingLevel } from '../types.js';

// ---------------------------------------------------------------------------
// Redis keys — shared with routes/check-episodes.ts, which reads the same
// API key and Gemini choice this form writes.
// ---------------------------------------------------------------------------

export const REDIS_KEY_GOOGLE_API_KEY = 'google_api_key';
export const REDIS_KEY_STICKY_SLOT = 'last_episode_sticky_slot';
export const REDIS_KEY_GEMINI_MODEL = 'gemini_model';
export const REDIS_KEY_THINKING_LEVEL = 'gemini_thinking_level';

/** Select value meaning "no override". */
export const DEFAULT_CHOICE = 'default';

/**
 * Key for the Redis draft that carries step 1's computed model into step 2
 * of the "Configure bot" form chain — a Devvit Web form submit endpoint only
 * receives its own fields, so the model step 1 just resolved (and wrote)
 * can't ride along in the form response itself.
 */
export function configureBotDraftKey(userId: string | undefined): string {
  return `configure_bot_draft:${userId ?? 'unknown'}`;
}

/** Comfortably past the moderator menu/form 10-minute completion window;
 * never relied on beyond it. */
export const CONFIGURE_BOT_DRAFT_EXPIRY_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Gemini model + thinking level — advanced, optional overrides. Unset means
// DEFAULT_GEMINI_MODEL with no reasoning_effort (the model decides how much
// to think).
// ---------------------------------------------------------------------------

type RedisClient = {
  get: (key: string) => Promise<string | undefined>;
};

export interface GeminiChoice {
  model: string;
  isDefaultModel: boolean;
  thinkingLevel: ThinkingLevel | undefined;
}

export async function getGeminiChoice(redis: RedisClient): Promise<GeminiChoice> {
  const [storedModel, storedLevel] = await Promise.all([
    redis.get(REDIS_KEY_GEMINI_MODEL),
    redis.get(REDIS_KEY_THINKING_LEVEL),
  ]);
  const model = storedModel || DEFAULT_GEMINI_MODEL;
  return { model, isDefaultModel: !storedModel, thinkingLevel: resolveThinkingLevel(model, storedLevel) };
}

/** Devvit Web select fields submit (and pre-populate) as a one-item array. */
export function firstSelectValue(values: string[] | undefined): string | undefined {
  return values?.[0];
}

// ---------------------------------------------------------------------------
// Form field builders
// ---------------------------------------------------------------------------

/** `current` null = the recommended default. A model a newer catalog build
 * dropped stays listed so a save never silently switches it. */
export function modelSelectField(current: string | null): FormField {
  const defaultName = GEMINI_MODELS.find(m => m.id === DEFAULT_GEMINI_MODEL)?.name ?? DEFAULT_GEMINI_MODEL;
  const options = [
    { label: `Recommended: ${defaultName}`, value: DEFAULT_CHOICE },
    ...GEMINI_MODELS.map(m => ({ label: describeModel(m), value: m.id })),
  ];
  if (current && !GEMINI_MODELS.some(m => m.id === current)) {
    options.push({ label: `${current} (no longer listed)`, value: current });
  }
  return {
    type: 'select',
    name: 'geminiModel',
    label: 'Gemini model',
    helpText:
      "Leave on Recommended unless you need a specific model. Recommended follows Google's newest Flash model.",
    options,
    defaultValue: [current ?? DEFAULT_CHOICE],
    required: true,
  };
}

export function customizeThinkingField(defaultValue: boolean): FormField {
  return {
    type: 'boolean',
    name: 'customizeThinking',
    label: 'Choose a thinking level',
    helpText: 'Off: the model decides how much to think (recommended). On: pick a level on the next screen.',
    defaultValue,
  };
}

export function thinkingLevelSelectField(model: string, current: ThinkingLevel | undefined): FormField {
  return {
    type: 'select',
    name: 'thinkingLevel',
    label: 'Thinking level',
    helpText: 'More thinking can improve the discussion but is slower; Gemini has 20 seconds to answer.',
    options: [
      { label: 'Model default (recommended)', value: DEFAULT_CHOICE },
      ...thinkingLevelsFor(model).map(level => ({ label: describeThinkingLevel(level), value: level })),
    ],
    defaultValue: [current ?? DEFAULT_CHOICE],
    required: true,
  };
}

// ---------------------------------------------------------------------------
// Form assembly
// ---------------------------------------------------------------------------

export interface ConfigureBotFormData {
  hasApiKey: boolean;
  currentSlot: 1 | 2;
  storedModel: string | null;
  hasThinkingLevel: boolean;
}

export function buildConfigureBotForm(data: ConfigureBotFormData): Form {
  return {
    title: 'Configure bot',
    description:
      "The Google API key is stored in this subreddit's Redis store, not in the app settings. Get a free key from Google Cloud Console with YouTube Data API v3 and Generative Language API enabled.",
    fields: [
      {
        type: 'string',
        name: 'apiKey',
        label: 'Google API Key',
        helpText: data.hasApiKey ? 'A key is saved. Leave blank to keep it.' : 'Required before the bot can run.',
        required: !data.hasApiKey,
      },
      {
        type: 'select',
        name: 'pinSlot',
        label: 'Pin slot',
        helpText: "Which of the subreddit's two sticky slots new episode posts take.",
        options: [
          { label: '1 (top)', value: '1' },
          { label: '2', value: '2' },
        ],
        defaultValue: [data.currentSlot === 2 ? '2' : '1'],
        required: true,
      },
      {
        type: 'group',
        label: 'Advanced (optional)',
        fields: [modelSelectField(data.storedModel), customizeThinkingField(data.hasThinkingLevel)],
      },
    ],
    acceptLabel: 'Save',
    cancelLabel: 'Cancel',
  };
}

export interface ThinkingLevelFormData {
  model: string;
  thinkingLevel: ThinkingLevel | undefined;
}

export function buildThinkingLevelForm(data: ThinkingLevelFormData): Form {
  return {
    title: 'Configure bot: thinking level',
    description: `Levels ${data.model} accepts. Saved for every check; "Regenerate discussion" can override it per run.`,
    fields: [thinkingLevelSelectField(data.model, data.thinkingLevel)],
    acceptLabel: 'Save',
    cancelLabel: 'Keep current',
  };
}

// ---------------------------------------------------------------------------
// Submission decisions — pure, so the route only has to apply them.
// ---------------------------------------------------------------------------

export interface ConfigureBotSubmission {
  apiKey?: string;
  pinSlot?: string[];
  geminiModel?: string[];
  customizeThinking?: boolean;
}

export interface ConfigureBotDecision {
  /** Non-null = write; null = leave the saved key alone (field left blank). */
  apiKeyToSet: string | null;
  slot: '1' | '2';
  /** Non-null = write; null = delete (falls back to DEFAULT_GEMINI_MODEL). */
  storedModel: string | null;
  /** Resolved effective model, for display and for the thinking-level step. */
  model: string;
  clearThinkingLevel: boolean;
  openThinkingForm: boolean;
  thinkingFormDefault: ThinkingLevel | undefined;
  toast: string;
}

export function decideConfigureBotSubmission(
  values: ConfigureBotSubmission,
  previous: GeminiChoice
): ConfigureBotDecision {
  const apiKeyToSet = values.apiKey?.trim() || null;
  const slot = firstSelectValue(values.pinSlot) === '2' ? '2' : '1';
  const picked = firstSelectValue(values.geminiModel);
  const storedModel = picked && picked !== DEFAULT_CHOICE ? picked : null;
  const model = storedModel ?? DEFAULT_GEMINI_MODEL;
  const customizeThinking = values.customizeThinking === true && thinkingLevelsFor(model).length > 0;
  const sameModel = model === previous.model;

  return {
    apiKeyToSet,
    slot,
    storedModel,
    model,
    // A level picked for another model may not apply, so any path other
    // than "customizing, same model" clears the stored override.
    clearThinkingLevel: !(customizeThinking && sameModel),
    openThinkingForm: customizeThinking,
    thinkingFormDefault: customizeThinking && sameModel ? previous.thinkingLevel : undefined,
    toast: apiKeyToSet ? `API key saved; ${model}; pin slot ${slot}.` : `Saved ${model}; pin slot ${slot}.`,
  };
}

export interface ThinkingLevelDecision {
  /** undefined = delete the stored override (model decides). */
  level: ThinkingLevel | undefined;
  toast: string;
}

export function decideThinkingLevelSubmission(model: string, chosen: string[] | undefined): ThinkingLevelDecision {
  const level = resolveThinkingLevel(model, firstSelectValue(chosen));
  return {
    level,
    toast: level ? `${model} will use ${level} thinking.` : `${model} will decide how much to think.`,
  };
}
