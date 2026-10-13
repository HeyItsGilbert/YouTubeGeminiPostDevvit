// Refreshes src/geminiModels.generated.ts: the Gemini models offered in the
// "Configure bot" / "Regenerate discussion" forms and the preview site, and
// the thinking levels each one accepts.
//
// Each listed model first gets one plain request; a 400/404 (retired, or
// Interactions-API-only) drops it. The models API only says whether a model
// thinks, not which levels it takes (docs/research/gemini-model-thinking-levels.md),
// so each thinking model is then probed once per level on the same
// OpenAI-compatible endpoint the bot calls: 200 = accepted, 400 = rejected.
// Anything else (rate limit, outage) is inconclusive and keeps the levels
// from the previous catalog.
//
// Usage: GEMINI_API_KEY=... node scripts/sync-gemini-models.mjs
// (`npm run models:sync` reads the key from .env; `npm run deploy` runs it first.)

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const OUT_FILE = new URL('../src/geminiModels.generated.ts', import.meta.url);

// Least to most thinking. Must match ThinkingLevel in src/types.ts — the
// generated file is typed against it, so `npm run type-check` catches drift.
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high'];

// generateContent models that can't (or shouldn't) write a text post.
const NON_TEXT_MODEL = /tts|image|banana|embedding|audio|live|transcribe|computer-use|robotics|customtools/i;

const PROBE_TIMEOUT_MS = 60_000;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set. Add it to .env (see DEVELOP.md) or export it.');
  process.exit(1);
}

async function listModels() {
  const models = [];
  let pageToken = '';
  do {
    const url = `${API}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`ListModels failed: ${res.status} ${await res.text()}`);
    }
    const page = await res.json();
    models.push(...(page.models ?? []));
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return models;
}

/** 'accepted' | 'rejected' | 'gone' (model can't generate at all) | 'unknown' */
async function probe(modelId, level) {
  let res;
  try {
    res = await fetch(`${API}/openai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 16,
        reasoning_effort: level,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`  ${modelId} ${level}: request failed (${err.message})`);
    return 'unknown';
  }
  if (res.ok) return 'accepted';
  if (res.status === 400) return 'rejected';
  if (res.status === 404) return 'gone';
  const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
  console.warn(`  ${modelId} ${level}: ${res.status} ${text}`);
  return 'unknown';
}

async function readPreviousLevels() {
  try {
    const source = await readFile(OUT_FILE, 'utf8');
    const catalog = JSON.parse(source.slice(source.indexOf('= {') + 2, source.lastIndexOf(';')));
    return new Map(catalog.models.map(m => [m.id, m.thinkingLevels]));
  } catch {
    return new Map();
  }
}

const previousLevels = await readPreviousLevels();
const listed = (await listModels()).filter(m =>
  m.supportedGenerationMethods?.includes('generateContent') &&
  String(m.name).startsWith('models/gemini') &&
  !NON_TEXT_MODEL.test(m.name),
);
console.log(`Found ${listed.length} text-capable Gemini models.`);

const models = [];
for (const m of listed) {
  const id = String(m.name).replace(/^models\//, '');
  const name = m.displayName || id;
  // Some listed models can't serve this endpoint at all: retired for new
  // users (404) or Interactions-API-only (400) — drop those.
  const baseline = await probe(id, undefined);
  if (baseline === 'gone' || baseline === 'rejected') {
    console.log(`${id}: listed but can't generate on the OpenAI-compatible endpoint — dropped`);
    continue;
  }
  if (!m.thinking) {
    models.push({ id, name, thinkingLevels: [] });
    console.log(`${id}: no thinking`);
    continue;
  }
  // Levels in parallel (one model's quota), models in sequence.
  const results = await Promise.all(LEVELS.map(level => probe(id, level)));
  let thinkingLevels = LEVELS.filter((_, i) => results[i] === 'accepted');
  if (results.includes('unknown')) {
    thinkingLevels = previousLevels.get(id) ?? thinkingLevels;
    console.log(`${id}: probe inconclusive — using ${previousLevels.has(id) ? 'previous' : 'partial'} levels [${thinkingLevels.join(', ')}]`);
  } else {
    console.log(`${id}: [${thinkingLevels.join(', ')}]`);
  }
  models.push({ id, name, thinkingLevels });
}

if (models.length === 0) {
  throw new Error('No usable models found; leaving the existing catalog untouched.');
}

const catalog = { fetchedAt: new Date().toISOString(), models };
await writeFile(
  OUT_FILE,
  `// Generated by scripts/sync-gemini-models.mjs (npm run models:sync). Do not edit by hand.\n` +
  `import type { GeminiModelCatalog } from './types.js';\n\n` +
  `export const GEMINI_MODEL_CATALOG: GeminiModelCatalog = ${JSON.stringify(catalog, null, 2)};\n`,
);
console.log(`Wrote ${models.length} models to src/geminiModels.generated.ts`);
