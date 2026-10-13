/**
 * The Gemini model catalog and thinking-level rules, shared by the Devvit app
 * and the preview site. Like postUtils.ts: no Devvit or browser dependencies.
 */

import type { GeminiModel, ThinkingLevel } from './types.js';
import { GEMINI_MODEL_CATALOG } from './geminiModels.generated.js';

// The API exposes no speed or price field, so we derive a relative tier from the
// model id. Lower rank = faster/cheaper, so it sorts first and gets recommended.
// `cost` is a relative indicator ($–$$$), not an absolute price.
export type ModelTier = { rank: number; speed: string; cost: string };

export function classifyModel(id: string): ModelTier {
  const lower = id.toLowerCase();
  if (lower.includes('lite')) return { rank: 0, speed: 'Fastest', cost: '$' };
  if (lower.includes('flash')) return { rank: 1, speed: 'Fast', cost: '$$' };
  if (lower.includes('pro')) return { rank: 3, speed: 'Slower', cost: '$$$' };
  return { rank: 2, speed: '', cost: '$$' };
}

/** Catalog models, fastest/cheapest first. */
export const GEMINI_MODELS: readonly GeminiModel[] = [...GEMINI_MODEL_CATALOG.models]
  .sort((a, b) => classifyModel(a.id).rank - classifyModel(b.id).rank);

/** When `npm run models:sync` last refreshed the catalog (ISO 8601). */
export const GEMINI_MODELS_FETCHED_AT = GEMINI_MODEL_CATALOG.fetchedAt;

/**
 * Used unless a mod picks a model under Advanced. Google's rolling alias for
 * its newest Flash model: fast, free-tier, and outlives versioned IDs such as
 * `gemini-3-pro-preview`, which Google retires.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

/** "Gemini 3 Flash — Fast · $$" */
export function describeModel(model: GeminiModel): string {
  const tier = classifyModel(model.id);
  const meta = [tier.speed, tier.cost].filter(Boolean).join(' · ');
  return meta ? `${model.name} — ${meta}` : model.name;
}

/** Levels the model accepts, least to most. Empty for non-thinking or uncatalogued models. */
export function thinkingLevelsFor(modelId: string): ThinkingLevel[] {
  return GEMINI_MODELS.find(m => m.id === modelId)?.thinkingLevels ?? [];
}
/**
 * The level to request: `chosen` when `modelId` accepts it, otherwise
 * `undefined`, which sends no `reasoning_effort` so the model uses its own
 * default. No override is the normal case; levels are an advanced opt-in.
 */
export function resolveThinkingLevel(modelId: string, chosen?: string | null): ThinkingLevel | undefined {
  return thinkingLevelsFor(modelId).find(level => level === chosen);
}

export function describeThinkingLevel(level: ThinkingLevel): string {
  return level === 'none' ? 'None (thinking off)' : level[0].toUpperCase() + level.slice(1);
}
