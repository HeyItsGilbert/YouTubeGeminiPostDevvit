/**
 * Pure `Form` builders for the "Regenerate discussion" menu action. Kept
 * free of Devvit server/client imports (besides the `Form` type itself) so
 * they're testable without a live Devvit context — see routes/regenerate.ts
 * for the handlers that call these and talk to Redis/Reddit.
 */

import type { Form } from '@devvit/web/shared';
import type { GeminiModel, ThinkingLevel } from '../types.js';
import { describeModel, describeThinkingLevel, resolveThinkingLevel } from '../geminiModels.js';

/** Submitted values for the step 1 form (`regenerateStep1Form`). Selects always submit as arrays. */
export interface Step1FormValues {
  systemPrompt: string;
  model: string[];
  chooseThinkingLevel: boolean;
}

/** Submitted values for the step 2 form (`regenerateStep2Form`). */
export interface Step2FormValues {
  thinkingLevel: string[];
}

/** Sentinel `thinkingLevel` value meaning "use the model's configured default", not an override. */
export const MODEL_DEFAULT_THINKING_LEVEL = 'default';

/** Resolve the one-off thinking selection; Model default deliberately omits an override. */
export function resolveRegenerationThinkingLevel(model: string, selection: string): ThinkingLevel | null {
  return selection === MODEL_DEFAULT_THINKING_LEVEL ? null : resolveThinkingLevel(model, selection) ?? null;
}

/** Carry the matching draft request through Devvit's step-two select field. */
export function encodeThinkingLevelSelection(requestId: string, level: string): string {
  return `${requestId}:${level}`;
}

/** Decode a request-bound thinking selection, rejecting malformed form data. */
export function decodeThinkingLevelSelection(values: string[] | undefined): { requestId: string; level: string } | undefined {
  const value = values?.[0];
  const separator = value?.indexOf(':') ?? -1;
  if (separator <= 0 || separator === value!.length - 1) return undefined;
  return { requestId: value!.slice(0, separator), level: value!.slice(separator + 1) };
}

const SUBMISSION_WINDOW_WARNING =
  'Submit within about 10 minutes of opening this form — moderator actions expire after that. ' +
  "If nothing happens after submitting, try again from the post's \"…\" menu.";

/**
 * Step 1: the system prompt (pre-filled from the configured setting) plus
 * an "Advanced (optional)" group with a model override and a toggle to
 * choose a thinking level on step 2. Without the toggle, the run uses the
 * selected model's configured thinking level if accepted, else none.
 */
export function buildStep1Form(opts: {
  systemPrompt: string;
  models: readonly GeminiModel[];
  selectedModel: string;
}): Form {
  const modelOptions = opts.models.map((model) => ({ label: describeModel(model), value: model.id }));
  if (!opts.models.some((model) => model.id === opts.selectedModel)) {
    modelOptions.push({ label: `${opts.selectedModel} (no longer listed)`, value: opts.selectedModel });
  }
  return {
    title: 'Regenerate discussion',
    description: SUBMISSION_WINDOW_WARNING,
    acceptLabel: 'Continue',
    fields: [
      {
        type: 'paragraph',
        name: 'systemPrompt',
        label: 'System prompt',
        defaultValue: opts.systemPrompt,
        required: true,
      },
      {
        type: 'group',
        label: 'Advanced (optional)',
        fields: [
          {
            type: 'select',
            name: 'model',
            label: 'Model',
            options: modelOptions,
            defaultValue: [opts.selectedModel],
          },
          {
            type: 'boolean',
            name: 'chooseThinkingLevel',
            label: 'Choose a thinking level for this run',
            defaultValue: false,
          },
        ],
      },
    ],
  };
}

/**
 * Step 2: shown only when step 1's toggle was on. Offers "Model default"
 * (no override) plus every thinking level the step 1-selected model accepts.
 */
export function buildStep2Form(opts: { levels: readonly ThinkingLevel[]; requestId: string }): Form {
  return {
    title: 'Choose a thinking level',
    acceptLabel: 'Regenerate',
    fields: [
      {
        type: 'select',
        name: 'thinkingLevel',
        label: 'Thinking level for this run',
        options: [
          { label: 'Model default', value: encodeThinkingLevelSelection(opts.requestId, MODEL_DEFAULT_THINKING_LEVEL) },
          ...opts.levels.map((level) => ({
            label: describeThinkingLevel(level),
            value: encodeThinkingLevelSelection(opts.requestId, level),
          })),
        ],
        defaultValue: [encodeThinkingLevelSelection(opts.requestId, MODEL_DEFAULT_THINKING_LEVEL)],
      },
    ],
  };
}
