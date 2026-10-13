# Which Gemini models exist, and which thinking levels each accepts

Research for dropping the probing step `npm run models:sync` (`scripts/sync-gemini-models.mjs`).
All live observations were made on **2026-10-13** with the project's `GEMINI_API_KEY`.
Anything not directly observed in a source is marked **[INFERENCE]**.

## Answer

**No.** No Google API surface returns the thinking levels (or a thinking-budget range) a model accepts. `models.list`/`models.get` (v1, v1beta, v1alpha), the OpenAI-compatible `/openai/models`, the Interactions API spec, Vertex AI `PublisherModel` and the official SDKs expose at most `thinking: boolean`. Google publishes the per-model levels only as prose tables in the docs. Those tables can be fetched as Markdown (`*.md.txt`), but they are incomplete, inconsistent across pages, and wrong about `none` on the OpenAI-compatible endpoint. The best substitute is **models.dev** (`https://models.dev/api.json`, keyless, CORS `*`, per-model `effort` lists that matched the Google docs and our probe for every model checked, apart from `none`). Fetch it at build time, take the model list and the `thinking` flag from `models.list` at runtime, and on a `400 "Thinking level X is not supported"` step down a level and retry. None of this tells you which models accept `none`, so either keep a small probe just for `none` or stop offering it on models where Google's docs say thinking can't be turned off.

## Sources checked

| Source | URL | Auth | Model list? | Accepted levels? | Freshness (observed 2026-10-13) | Devvit runtime | Browser (CORS) |
|---|---|---|---|---|---|---|---|
| Gemini `models.list` / `models.get` (v1beta, v1alpha, v1) | `https://generativelanguage.googleapis.com/v1beta/models` | API key (unauthenticated → 403) | Yes (63 in v1beta/v1alpha, 24 in v1) | **No**: only `thinking: boolean` | Live | Yes (allowed domain) | Yes (preflight echoes origin, allows `x-goog-api-key`) |
| Discovery documents | `https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta` (also `v1`, `v1alpha`) | None | Schema only | **No**: `ThinkingConfig.thinkingLevel` enum is global, not per model | Revisions 20261013 / 20261012 | Yes | Yes |
| OpenAI-compatible models | `https://generativelanguage.googleapis.com/v1beta/openai/models` | API key (Bearer) | Yes | **No**: `id`, `object`, `owned_by`, `display_name` only | Live | Yes | Not tested [INFERENCE: same host, likely yes] |
| Interactions API OpenAPI spec | `https://ai.google.dev/static/api/interactions.openapi.json` | None | Enum of model ids (`ModelOption`) | **No**: global `ThinkingLevel` enum | Live | No (ai.google.dev not allowed) | No `Access-Control-Allow-Origin` header |
| Vertex AI `PublisherModel` | `https://aiplatform.googleapis.com/v1beta1/publishers/google/models/{id}` | OAuth2 only (API keys rejected) | Yes | **No**: no thinking fields on `PublisherModel` | Discovery rev 20261007 | No | n/a (OAuth) |
| google-genai Python / JS SDKs | github.com/googleapis/python-genai, github.com/googleapis/js-genai | n/a | No | **No**: only a model→tokenizer table | HEAD 2026-10-13 | n/a | n/a |
| Gemini docs Markdown: thinking pages, per-model pages, `llms.txt` | `https://ai.google.dev/gemini-api/docs/thinking.md.txt` etc. | None | Partial | **Yes, as prose tables**, but incomplete and inconsistent | "Last updated 2026-10-13" | No | No `Access-Control-Allow-Origin` header |
| OpenRouter Models API | `https://openrouter.ai/api/v1/models` | None | Yes (OpenRouter ids `google/...`) | **Yes**: `reasoning.supported_efforts`, `mandatory` | `gemini-4-argon` created 2026-10-13 16:04 UTC | No | Yes (`*`) |
| models.dev | `https://models.dev/api.json` | None | Yes (Gemini API ids) | **Yes**: `reasoning_options[{type:"effort",values}]`, plus `budget_tokens` min/max for 2.5 | `gemini-4-argon` merged 2026-10-13 | No | Yes (`*`) |
| LiteLLM price map | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | None | Yes | **Boolean only** (`supports_reasoning`, sometimes `supports_minimal_reasoning_effort`) | Last commit 2026-10-13 18:03 UTC | No | Yes (`*`) |

The live auth and CORS results come from `curl` on 2026-10-13. Unauthenticated `GET /v1beta/models` returned `403 PERMISSION_DENIED` ("Method doesn't allow unregistered callers"). An `OPTIONS` preflight to the same URL with a Netlify origin returned `access-control-allow-origin: <origin>` and `access-control-allow-headers: x-goog-api-key`. `ai.google.dev` `.md.txt` and `.openapi.json` responses carried no `access-control-allow-origin` header. Vertex returned `401 "API keys are not supported by this API. Expected OAuth2 access token"`.

## Q1: Does any Gemini API surface return accepted thinking levels?

**No.** Each surface:

### `models.list` / `models.get` (Gemini API)
- **Discovery schema.** In all three discovery documents ([v1beta](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta), [v1](https://generativelanguage.googleapis.com/$discovery/rest?version=v1), [v1alpha](https://generativelanguage.googleapis.com/$discovery/rest?version=v1alpha)), `schemas.Model.properties` contains exactly: `baseModelId, description, displayName, inputTokenLimit, maxTemperature, name, outputTokenLimit, supportedGenerationMethods, temperature, thinking, topK, topP, version`. `thinking` is `boolean`: "Whether the model supports thinking." No schema field name contains `capab`, `level` or `budget` except `ThinkingConfig.thinkingLevel` and `ThinkingConfig.thinkingBudget`. Those are request fields, and `thinkingLevel` is one global enum (`THINKING_LEVEL_UNSPECIFIED, MINIMAL, LOW, MEDIUM, HIGH`) whose description says "The default value is model-dependent. Refer to the Thinking levels guide". `models.list` takes only `pageSize`/`pageToken` and `models.get` takes only `name`, so there is no `view`/`readMask` that could reveal more. The only other model-metadata schema is `ModelStatus` (`modelStage`, `message`), and it is attached to `GenerateContentResponse.modelStatus`, not to `Model`.
- **Real responses** (observed). `GET v1beta/models?pageSize=1000` returned 63 models whose union of keys is exactly the schema above (`thinking` present on 37). `v1alpha` returned the same. `v1` returned 24 models with the same keys. `GET v1beta/models/gemini-3-flash-preview` returned `"thinking": true` and no other thinking field, and adding `$fields=*` changed nothing.
- **Side finding.** `GET v1beta/models/gemini-3-pro-preview` returns 200 (`"thinking": true`) although the model is absent from `models.list`. A chat completion against it returns `404 "This model models/gemini-3-pro-preview is no longer available. Please update your code to use models/gemini-3.1-pro-preview"`. `models.get` returning 200 therefore does not mean a model is usable. The current script's 404-on-generate → "gone" rule is still needed.
- **SDK fixtures.** The official `models_list` sample in [google-gemini/api-examples `python/models.py` L20-L38](https://github.com/google-gemini/api-examples/blob/4d282409f4a0a31eb11e00fb7c598df03be3c595/python/models.py#L20-L38) only filters on `supported_actions`. The python-genai list test [`tests/models/test_list.py`](https://github.com/googleapis/python-genai/blob/a0d809cd838ec02938c1646c47cc3ece2761fc09/google/genai/tests/models/test_list.py#L85-L106) only asserts on paging and headers. No published fixture shows a level field.

### OpenAI-compatible `GET /v1beta/openai/models`
The docs show only `model.id` usage ([openai docs, "List models"](https://ai.google.dev/gemini-api/docs/openai#list-models)). Observed: 63 entries, keys `id, object, owned_by, display_name` only. `GET /v1beta/openai/models/gemini-3-pro-preview` returned the same four keys.

### Interactions API
The Interactions OpenAPI spec ([interactions.openapi.json](https://ai.google.dev/static/api/interactions.openapi.json), linked from [the API reference](https://ai.google.dev/api/interactions-api)) has no models path. Its paths are agents, credentials, environments, interactions, triggers, voices and webhooks. `components.schemas.ModelOption` is a string enum of model ids with descriptions. `components.schemas.ThinkingLevel` is a single global enum `["minimal","low","medium","high"]`, so nothing ties levels to a model.

### Vertex AI publisher models / Model Garden
In the [aiplatform v1beta1 discovery doc](https://aiplatform.googleapis.com/$discovery/rest?version=v1beta1), `GoogleCloudAiplatformV1beta1PublisherModel` has `frameworks, launchStage, name, openSourceCategory, parent, predictSchemata, publisherModelTemplate, supportedActions, versionId, versionState`, with no thinking fields. Thinking fields appear only on request/tuning schemas (`GenerationConfigThinkingConfig.thinkingLevel/thinkingBudget`, `ReinforcementTuningHyperParameters`). Live: `GET .../publishers/google/models/gemini-3.1-pro-preview` returned 401 with no credentials and with an API key ("API keys are not supported by this API"). The domain is also not allowed in Devvit.

### Official SDKs
- python-genai `Model` ([types.py L10977](https://github.com/googleapis/python-genai/blob/a0d809cd838ec02938c1646c47cc3ece2761fc09/google/genai/types.py#L10977)) has `thinking: Optional[bool]` ([L11056](https://github.com/googleapis/python-genai/blob/a0d809cd838ec02938c1646c47cc3ece2761fc09/google/genai/types.py#L11056)) and no level field. `ThinkingLevel` is a global enum ([L375](https://github.com/googleapis/python-genai/blob/a0d809cd838ec02938c1646c47cc3ece2761fc09/google/genai/types.py#L375)).
- js-genai `Model` ([src/types.ts L4645](https://github.com/googleapis/js-genai/blob/f2ad2c1107d9ed0b09aa0a8116f2c093a7628a45/src/types.ts#L4645)) has `thinking?: boolean` ([L4696](https://github.com/googleapis/js-genai/blob/f2ad2c1107d9ed0b09aa0a8116f2c093a7628a45/src/types.ts#L4696)).
- The only hard-coded per-model table in either SDK maps model ids to local tokenizers ([python `_local_tokenizer_loader.py` L47](https://github.com/googleapis/python-genai/blob/a0d809cd838ec02938c1646c47cc3ece2761fc09/google/genai/_local_tokenizer_loader.py#L47), [js `_loader.ts` L21](https://github.com/googleapis/js-genai/blob/f2ad2c1107d9ed0b09aa0a8116f2c093a7628a45/src/cross/tokenizer/_loader.ts#L21)). I searched both repos for level/capability tables (`thinking_levels`, `supported_thinking`, `minimal.*low.*medium.*high`) and found none, apart from a sample-benchmark type alias.

### Machine-readable Google catalog
Google publishes no JSON model catalog with levels. The only machine-readable form is the docs Markdown (Q3).

## Q2: Third-party catalogs

All three are keyless and serve `Access-Control-Allow-Origin: *` (observed).

### OpenRouter `GET /api/v1/models`
- **Docs.** [Reasoning tokens → "Discovering per-model reasoning options"](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) describes a per-model `reasoning` object with `supported_efforts` ("Filter effort selectors to these values"), `default_effort`, `default_enabled`, and `mandatory` ("When `true` … do not send `effort: "none"` — the model rejects it"). [Models overview](https://openrouter.ai/docs/guides/overview/models) says the schema "is cached at the edge".
- **Gives levels.** Yes, but in OpenRouter's vocabulary and for OpenRouter's gateway. The same page says that if a model "doesn't support a specific effort level … OpenRouter will map your requested effort to the nearest supported level". Gemini 2.5 entries have only `{"mandatory": …}` and no effort list.
- **Ids.** Prefixed `google/…`. Retired models drop out (no `gemini-3-pro-preview`). Some models are missing (`gemini-flash-latest`, `gemini-pro-latest`).
- **`none` semantics differ from Google's endpoint.** OpenRouter marks `gemini-3.5-flash`, `3.6-flash`, `3.7-flash`, `3.8-flash` and `gemini-4-argon` as `mandatory: true` (no `none`). Google's OpenAI-compatible endpoint accepts `none` for all of them (see the comparison below).

### models.dev
- **Source and schema.** Hand-maintained TOML in [sst/models.dev](https://github.com/sst/models.dev), compiled to `https://models.dev/api.json`. The `ReasoningOption` type ([packages/sdk/src/types.ts L19-L40](https://github.com/sst/models.dev/blob/34b87c8a9e59739a7c06286a487f50e3a2dea4ee/packages/sdk/src/types.ts#L19-L40)) is `toggle | effort{values} | budget_tokens{min,max}`, and `values` are "Effort values the provider accepts for this model". The contributor policy makes `reasoning_options` "Required when `reasoning = true`" ([AGENTS.md L133](https://github.com/sst/models.dev/blob/34b87c8a9e59739a7c06286a487f50e3a2dea4ee/AGENTS.md#L133), [L184](https://github.com/sst/models.dev/blob/34b87c8a9e59739a7c06286a487f50e3a2dea4ee/AGENTS.md#L184)).
- **Example.** [`providers/google/models/gemini-3-flash-preview.toml` L14-L16](https://github.com/sst/models.dev/blob/34b87c8a9e59739a7c06286a487f50e3a2dea4ee/providers/google/models/gemini-3-flash-preview.toml#L14-L16) has `values = ["minimal", "low", "medium", "high"]`. [`gemini-3.1-pro-preview.toml` L16](https://github.com/sst/models.dev/blob/34b87c8a9e59739a7c06286a487f50e3a2dea4ee/providers/google/models/gemini-3.1-pro-preview.toml#L16) has `["low", "medium", "high"]`.
- **Gives levels.** Yes, using the Gemini API's own model ids under `google.models` (40 entries, including the `*-latest` aliases). For Gemini 2.5 it gives `budget_tokens` min/max (e.g. 2.5 Pro 128–32768, 2.5 Flash 0–24576), matching the [generateContent thinking budget table](https://ai.google.dev/gemini-api/docs/generate-content/thinking#set-budget).
- **Freshness.** `gemini-4-argon` was added the same day it appeared in Google's docs (commit `34b87c8`, 2026-10-13). Hand-curated, so it can lag [INFERENCE].
- **`none`.** Never listed for Gemini 3+ models.

### LiteLLM `model_prices_and_context_window.json`
- **Gives levels.** Booleans only for Gemini, e.g. `"supports_reasoning": true` for [`gemini/gemini-3-flash-preview` (L30372-L30407)](https://github.com/BerriAI/litellm/blob/cb94567ed7f964c217120beab67e5e2c36738928/model_prices_and_context_window.json#L30372-L30407). A few entries add `"supports_minimal_reasoning_effort": false` (e.g. [`gemini/gemini-3.8-flash` L30657](https://github.com/BerriAI/litellm/blob/cb94567ed7f964c217120beab67e5e2c36738928/model_prices_and_context_window.json#L30657)). The file does have a `reasoning_effort_levels` list, but only for azure, openai, mistral and similar providers. No `gemini/*` entry has it.
- **Verdict.** Not usable for level lists.

### Comparison with the Google docs and live behaviour

"Docs" is the [thinking page "Levels Supported" table](https://ai.google.dev/gemini-api/docs/thinking#thinking-levels). "Probe" is the committed `src/geminiModels.generated.ts`, generated 2026-10-13 18:28 UTC via the OpenAI-compatible endpoint. "—" means the model is not in that source.

| Model | Docs | OpenRouter `supported_efforts` (mandatory) | models.dev `effort` | Probe (OpenAI-compat) |
|---|---|---|---|---|
| gemini-3-pro-preview | low, high | — (retired) | — | — (generate returns 404 "no longer available") |
| gemini-3-flash-preview | minimal, low, medium, high | minimal, low, medium, high (false) | minimal, low, medium, high | **none**, minimal, low, medium, high |
| gemini-3.1-pro-preview | low, medium, high | low, medium, high (true) | low, medium, high | low, medium, high |
| gemini-3.1-flash-lite | — | minimal, low, medium, high (false) | minimal, low, medium, high | **none**, minimal, low, medium, high |
| gemini-3.5-flash | — | minimal, low, medium, high (true) | minimal, low, medium, high | **none**, minimal, low, medium, high |
| gemini-3.5-flash-lite | minimal, low, medium, high | minimal, low, medium, high (true) | minimal, low, medium, high | minimal, low, medium, high |
| gemini-3.6-flash | minimal, low, medium, high | minimal, low, medium, high (true) | minimal, low, medium, high | **none**, minimal, low, medium, high |
| gemini-3.7-flash | — | low, medium, high (true) | low, medium, high | **none**, low, medium, high |
| gemini-3.8-flash | low, medium, high | low, medium, high (true) | low, medium, high | **none**, low, medium, high |
| gemini-4-argon | low, medium, high | low, medium, high (true) | low, medium, high | **none**, low, medium, high |
| gemini-flash-latest | — | — | low, medium, high | **none**, low, medium, high |
| gemini-flash-lite-latest | — | — | minimal, low, medium, high | minimal, low, medium, high |
| gemini-pro-latest | — | — | — | low, medium, high |
| gemini-nano-banana-2.1 | — | minimal, high (false) | — | medium, high |

- Leaving `none` aside, models.dev agrees with both the docs and the probe on every text model it lists. OpenRouter agrees on effort lists but not on `none`.
- The spot checks from the brief: gemini-3-pro-preview is low/high in the docs, but the model is retired, so neither catalog nor live calls can confirm it. gemini-3-flash-preview is minimal/low/medium/high in the docs, in OpenRouter and in models.dev.
- Only `gemini-nano-banana-2.1` disagrees between sources. It is an image model that the probe kept because its id doesn't match the script's `image` filter.

Live spot checks (2026-10-13, OpenAI-compatible endpoint, one request each):
- `gemini-3.1-pro-preview` + `reasoning_effort: "minimal"` → **400** `"Thinking level MINIMAL is not supported for this model. Please retry with other thinking level."`
- `gemini-3-flash-preview` + `"none"` → **200**. With a prime-counting prompt, `usage` was `prompt 22 / completion 2 / total 24` for `none` and `prompt 22 / completion 2 / total 557` for `high`. [INFERENCE: the 533-token gap is thought tokens, so `none` really disables thinking on this model.]
- `gemini-3.8-flash` + `"none"` → 200.
- `gemini-2.5-pro` + `"none"` → 404 `"no longer available to new users"`. Availability depends on the key's account, so a static catalog can't capture it.

## Q3: Can the docs table be fetched in machine-readable form?

**Yes, as Markdown, but it should not be the only source.**
- Appending `.md.txt` to a docs URL returns `text/markdown`, e.g. [`/gemini-api/docs/thinking.md.txt`](https://ai.google.dev/gemini-api/docs/thinking.md.txt). [`/gemini-api/docs/llms.txt`](https://ai.google.dev/gemini-api/docs/llms.txt) indexes every page in this form. `?format=md` and plain `.md` return HTML, and `https://ai.google.dev/llms.txt` returns 404. I found no public GitHub repo for the docs source (a search of the `google-gemini` org for "docs" returned only an unrelated sample).
- **The table exists in three places, and they disagree:**
  1. [`thinking.md.txt`](https://ai.google.dev/gemini-api/docs/thinking.md.txt) (Interactions-oriented page) has a pipe table `| Model | Default Thinking | Levels Supported |` with 12 rows (gemini-4-argon … gemini-robotics-er-2-preview). Easy to parse, but it omits `gemini-3.5-flash`, `gemini-3.7-flash`, `gemini-3.1-flash-lite`, the `*-latest` aliases, etc. It still lists the retired `gemini-3-pro-preview`.
  2. [`generate-content/thinking.md.txt`](https://ai.google.dev/gemini-api/docs/generate-content/thinking.md.txt) (native `thinkingConfig.thinkingLevel`, "Thinking levels (Gemini 3)") has a transposed table: rows are levels, columns are model families ("Gemini 3.5 & 3.1 Flash-Lite"), and cells read "Supported (Default)", "Not supported (error)", etc. That makes it hard to map to model ids. The same page has the 2.5 `thinkingBudget` ranges table.
  3. Per-model pages ([e.g. `models/gemini-3.8-flash.md.txt`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash.md.txt)) have a Capabilities cell. Only 3.8 and 3.7 Flash spell out levels ("Supported (low, medium, high) Note: `minimal` is not supported and returns an error"). The others say only "Supported", and `models/gemini-4-argon.md.txt` returned 404.
- **Not reachable from the runtime or the preview site.** These responses carry no `Access-Control-Allow-Origin` header, and `ai.google.dev` is not an allowed Devvit domain. A build-time scraper would work, but it would depend on prose layout that changes.

## Q4: Do native `thinkingLevel` values match OpenAI-compatible `reasoning_effort`?

**Mostly. Two documented details do not match observed behaviour.**
- The [OpenAI compatibility page, "Thinking"](https://ai.google.dev/gemini-api/docs/openai#thinking) maps `reasoning_effort` per family:

  | reasoning_effort | 3.1 Pro | 3.1 Flash-Lite | 3 Flash | 2.5 (`thinking_budget`) |
  |---|---|---|---|---|
  | minimal | low | minimal | minimal | 1,024 |
  | low | low | low | low | 1,024 |
  | medium | medium | medium | medium | 8,192 |
  | high | high | high | high | 24,576 |

  It then says: "If you want to disable thinking, you can set `reasoning_effort` to `"none"` for 2.5 models. Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models." It also says `reasoning_effort` and `thinking_level`/`thinking_budget` "can't be used at the same time".
- **Mismatch 1, `minimal` on 3.1 Pro.** The docs map `minimal` to `low`, but the live request returned **400** "Thinking level MINIMAL is not supported for this model". The native table on the generateContent thinking page marks `minimal` "Not supported" for 3.1 Pro. In practice `reasoning_effort` passes the level through to native `thinkingLevel` without the documented down-mapping [INFERENCE from this one observation].
- **Mismatch 2, `none` on 3.x Flash models.** The docs say thinking cannot be turned off for 3 models. Live, `none` returned 200 on gemini-3-flash-preview and gemini-3.8-flash, and the probe recorded `none` as accepted on most 3.x Flash models and gemini-4-argon (but not on 3.1 Pro or 3.5 Flash-Lite). The token counts above suggest thinking really is off [INFERENCE]. The native enum has no `NONE` value ([discovery `ThinkingConfig.thinkingLevel`](https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta)), so `none` exists only on the OpenAI-compatible surface (and natively as `thinkingBudget: 0` on 2.5).
- **Upshot.** For `minimal`/`low`/`medium`/`high`, the native per-model levels (docs, models.dev, OpenRouter) correctly predicted what the compat endpoint accepted for every model in the comparison table. **No source predicts `none`.**

## Recommendation for this repo

1. **Dropping `models:sync` entirely is not possible without losing information.** Nothing first-party lists levels, and no catalog lists `none`.
2. **Runtime model list in Devvit (feasible today).** Call `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000` with the subreddit's key. The domain is already allowed and the key is in Redis. This replaces the build-time model list, reflects per-account availability, and gives `thinking: boolean`. Cache it in Redis per subreddit with a TTL [INFERENCE: the TTL is a design choice].
3. **Levels.** Replace probing with a build-time fetch of `https://models.dev/api.json` (`google.models[*].reasoning_options`, effort values). No key, no quota, and it matched every non-`none` entry checked. Fetch at build time, not at runtime: `models.dev` is not an allowed Devvit domain and adding it needs Reddit approval. The preview site *could* fetch it live (CORS `*`), but bundling the same build-time snapshot keeps the bot and the preview consistent. OpenRouter is the second choice: it doesn't cover the `*-latest` aliases, its ids need the `google/` prefix stripped, and its `mandatory` flag means something different on Google's endpoint.
4. **`none`.** Pick one:
   - (a) Keep a much smaller probe that sends only `none`, one request per thinking model, at build time.
   - (b) Offer `none` only where Google documents it (2.5 non-Pro) and accept losing it on 3.x Flash.
   - (c) Offer `none` everywhere and rely on the fallback in 5.

   Option (a) is the smallest change that keeps today's behaviour.
5. **Fallbacks.**
   - At runtime, a `400` whose message matches `Thinking level .* is not supported` should retry once at the next level from `resolveThinkingLevel`'s ordering and remember the rejection in Redis. This covers catalog lag and models missing from models.dev.
   - Models that appear in `models.list` but not in the catalog should default to "no level control", as `thinkingLevelsFor` already does, rather than offering every level.
   - Keep treating `404` on generate as "unavailable". Retired models can still answer `models.get` with 200 (gemini-3-pro-preview), and availability can depend on the account (gemini-2.5-pro "no longer available to new users").
