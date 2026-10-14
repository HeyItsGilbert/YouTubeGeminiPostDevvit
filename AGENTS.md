# AGENTS.md — youtube-gemini-post

Guidance for AI agents and contributors working on this codebase.

If any of these instructions change, update this doc. Always check if there is a new devvit version.

---

## What this app does

A [Devvit](https://developers.reddit.com/docs/) app that monitors a YouTube playlist for new videos, calls the Gemini API to generate a Reddit discussion post, submits that post to the subreddit, and rotates the subreddit pin. Both APIs are free-tier. Every configuration value is mod-supplied per-subreddit — no developer secrets are shared.

---

## Repository map

```
src/
  main.ts           Entry point. Registers settings, menu items, scheduler jobs,
                    and triggers. Owns the top-level orchestration loop.
  checkerSchedule.ts ensureCheckerScheduled: keeps exactly one check_new_episodes cron
                    job alive ('reset' on install/upgrade, throttled 'heal' elsewhere).
  episodeChecker.ts YouTube Data API v3 client. Fetches playlists and individual
                    videos. Contains the exclusion-keyword filter.
  llmClient.ts      Gemini API client (via OpenAI-compatible endpoint). Delegates
                    message building and response parsing to postUtils.ts.
  geminiModels.ts   Platform-agnostic model catalog helpers shared with the preview
                    web app: GEMINI_MODELS (fastest first), DEFAULT_GEMINI_MODEL,
                    thinkingLevelsFor, resolveThinkingLevel, describe* labels.
  geminiModels.generated.ts
                    Committed model catalog (models + accepted thinking levels),
                    written by scripts/sync-gemini-models.mjs. Never hand-edit.
  postManager.ts    Reddit operations: link post submission with a distinguished, stickied
                    discussion comment, flair application, bot author flair, comment editing,
                    and pin rotation.
  postUtils.ts      Platform-agnostic pure utilities shared with the preview web app:
                    resolvePlaylistId, buildUserMessage, parseGeneratedResponse,
                    assemblePostBody. No Devvit or browser dependencies — safe to
                    import from both runtimes.
  videoRegistry.ts  Redis hash-backed registry of every video the bot has seen.
                    Stores status (posted/pending/excluded/rejected/skipped/private) and
                    postId/commentId per video ID. Posted records are terminal: never
                    overwritten (except by a forced repost) or deleted.
  types.ts          Shared interfaces: EpisodeData, GeneratedPost, VideoRecord,
                    ThinkingLevel, GeminiModel, GeminiModelCatalog.

scripts/sync-gemini-models.mjs
                    `npm run models:sync` (and `predeploy`): lists Gemini models and
                    probes each thinking model per reasoning_effort level.

devvit.json         App manifest. Declares entry point and allowed HTTP domains.
package.json        Build scripts and dependencies.
tsconfig.json       TypeScript config (module:ESNext, moduleResolution:Bundler).
netlify.toml        Netlify deploy config for the preview web app (base: preview-site/).
SystemPrompt.example.md
                    Sample mod-facing system prompt for Gemini — copy and adapt.
preview-site/
                    React + Vite web app for previewing generated posts before
                    deploying the bot. Imports shared logic from src/postUtils.ts
                    and src/types.ts via the @shared path alias.
```

---

## Architecture and data flow

### Normal run (every 30 minutes via cron, or manual mod trigger)

```
AppInstall / AppUpgrade trigger        → ensureCheckerScheduled('reset')
PostSubmit / CommentSubmit trigger,
any mod menu press                     → ensureCheckerScheduled('heal', ≤ once per 30 min)
  └─► scheduler.runJob('check_new_episodes', cron='*/30 * * * *') when missing

check_new_episodes job (src/main.ts)
  │
  ├─ 1. Read all settings (concurrently) + Google API key and Gemini choice
  │     (getGeminiChoice: model + resolved thinking level) from Redis
  ├─ 2. Validate: googleApiKey, youtubePlaylistId, systemPrompt required
  │
  ├─ 3. In parallel: fetchPlaylistVideos and the whole video registry
  │     (getAllVideoRecords — one hGetAll, not one hGet per video)
  │                                               episodeChecker.ts, videoRegistry.ts
  │       UC... channel ID is auto-converted to UU... uploads playlist
  │       GET playlistItems (maxResults=50, paginated) → sort by publishedAt (desc)
  │       → return EpisodeData[]
  │
  ├─ 4. For each video newest-first:                            videoRegistry.ts
  │       a. If job data has forceRepost (Testing Tool) — skip registry for first video only
  │       b. Look up videoRecords[video.guid] (pre-fetched) → skip if already registered
  │          (any status except 'private'; a private video is only recorded if unregistered)
  │       c. matchesExclusionFilter(title, excludeKeywords)     episodeChecker.ts
  │            → if matched: setVideoRecord(..., 'excluded'), continue
  │       d. First unregistered non-excluded video = episodeToPost
  │          Remaining unregistered videos → setVideoRecord(..., 'skipped')
  │
  ├─ 4½. If requireModApproval (or forceRepost) and `pending_post` exists → return
  │       (no Gemini call while a post awaits approval). Otherwise, on the approval
  │       path, the queued video is recorded as 'pending' after step 6.
  │
  ├─ 5. generateEpisodePost(apiKey, episode, systemPrompt, model, thinkingLevel)  llmClient.ts
  │       POST OpenAI-compat endpoint → parse first line = title, rest = body
  │
  ├─ 6. Assemble final discussion body (becomes the comment, not the post):
  │       [prependText, rawBody, appendText].filter(Boolean).join('\n\n')
  │
  ├─ 7. createEpisodePost(reddit, subredditName, title, url, body)  postManager.ts
  │       Submits a LINK post (url = episode.link) — gets Reddit's native thumbnail/
  │       preview card. Then posts `body` as a distinguished, stickied top-level
  │       comment on it (Reddit's post model can't carry both a url and a body).
  │       Returns { postId, commentId }.
  ├─ 8. applyFlair(...)           (if flairName set)            postManager.ts
  ├─ 9. applyBotFlair(...)        (if emoji or text set)        postManager.ts
  ├─ 10. managePins(reddit, redis, postId)                      postManager.ts
  │       Read `last_episode_sticky_slot` (default 1), sticky new post into that
  │       slot (Reddit atomically displaces the occupant — no explicit unsticky)
  │       Write `last_episode_sticky_slot` back to Redis
  │
  └─ 11. Persist: setVideoRecord(redis, episode.guid, { status: 'posted', postId, commentId })
```

### Regeneration flow (post menu → "Regenerate discussion")

Available on any post; the menu handler looks the post up in the video registry (`findVideoByPostId`) and toasts if it isn't an Episode Post or has no tracked `commentId` (posts created before the comment-based flow). Step 1 pre-fills the `systemPrompt` setting and, under an "Advanced (optional)" group, the configured model plus a "Choose a thinking level for this run" toggle (off). Without the toggle, the run uses the configured level if the chosen model accepts it, else none. With the toggle on, step 1 stores its answers in Redis (`regenerate_draft:<userId>`, 1 h expiry — a form's submit handler only receives its own fields) and opens step 2, which offers "Model default" plus that model's levels. Model, level, and prompt go to the `regenerate_discussion` job as job data and apply to that run only — the bot's configuration is never changed. The job re-runs Gemini and calls `updateEpisodePost` to edit the discussion comment. Does **not** re-submit, re-flair, or re-pin. Uses `fetchYouTubeVideoById` rather than the playlist. Step 1's submit handler reads the target from `context.postId`.

### Model catalog and thinking levels

Model and thinking level are **advanced, optional overrides**; mods aren't expected to know which model to pick. By default the bot uses `DEFAULT_GEMINI_MODEL` (`gemini-flash-latest`, Google's rolling alias for its newest Flash model, so it doesn't get retired like versioned IDs) and sends no `reasoning_effort`, letting the model decide how much to think.

Devvit settings can't show or hide a field based on another field, and their options are fixed at upload, so the overrides live in Redis and are chosen in forms. The model options come from `src/geminiModels.generated.ts`, refreshed by `npm run models:sync` (run by `predeploy`, needs `GEMINI_API_KEY` in the root `.env`). No Google API reports which levels a model accepts (`models.list` has only `thinking: boolean`; see `docs/research/gemini-model-thinking-levels.md`), so the script first sends each model one plain request (400/404 = dropped: retired, or Interactions-API-only), then probes each thinking model once per level (`none`, `minimal`, `low`, `medium`, `high`) on the same OpenAI-compatible endpoint the bot uses: 200 = accepted, 400 = rejected, anything else = inconclusive (keeps the previous catalog's levels).

"Configure bot" has an "Advanced (optional)" group: a model select whose first option, "Recommended", stores nothing (deletes `gemini_model`), and a "Choose a thinking level" toggle. With the toggle on and a model that accepts levels, saving opens a second form with "Model default" plus that model's levels. Toggle off, or a model change, deletes `gemini_thinking_level`. `resolveThinkingLevel(model, chosen)` returns `chosen` only if the model accepts it, else `undefined` (no `reasoning_effort`).

### Testing Tools

Devvit cannot hide menu items per install, so Testing Tools live inside forms that are only shown on a Playtest Install: `isPlaytestInstall` checks for a fourth version segment (`0.1.10.3`), which only pre-release versions from `devvit playtest` / `devvit upload --bump prerelease` have. Today the only Testing Tool is the force-repost checkbox on "Check for new videos"; on other installs that item runs a check immediately with no form. Add future Testing Tools the same way — never as their own menu item.

---

## Module reference

### `src/types.ts`

Defines the two shared shapes used across all modules.

```typescript
interface EpisodeData {
  guid: string;        // YouTube video ID — primary deduplication key
  title: string;       // Raw video title from YouTube
  description: string; // Raw video description from YouTube
  pubDate: string;     // ISO 8601 publish date
  link: string;        // https://www.youtube.com/watch?v=<videoId>
  episodeNumber?: string; // Not populated by the YouTube APIs; reserved for future use
}

interface GeneratedPost {
  title: string; // First non-empty line of Gemini output
  body: string;  // Everything after the title line
}
```

---

### `src/postUtils.ts`

Platform-agnostic pure utilities. **No Devvit APIs, no browser-only globals.** Safe to import from both the Devvit runtime and the preview web app.

| Export | Signature | Purpose |
|---|---|---|
| `resolvePlaylistId` | `(playlistId) → string` | Converts a `UC...` channel ID to its `UU...` uploads playlist ID; passes other IDs through unchanged. Used by both `episodeChecker.ts` and the preview app's playlist fetch. |
| `buildUserMessage` | `(episode) → string` | Assembles the user-turn message sent to Gemini. Conditionally includes `Episode Number` and `Link` fields. |
| `parseGeneratedResponse` | `(fullText, fallbackTitle) → GeneratedPost` | Splits raw Gemini output into title (first non-empty line) and body (everything after). |
| `matchesExclusionFilter` | `(title, keywords) → boolean` | Returns true if the title contains any comma-separated keyword (case-insensitive substring match). Used by `main.ts` for the exclusion keyword setting and by the preview app's filter UI. |
| `isPrivateVideo` | `(video) → boolean` | Returns true if the video title is exactly `"Private video"` — YouTube's placeholder for private/deleted content. Used by `main.ts` in `check_new_episodes` to record such videos with status `private`. |
| `assemblePostBody` | `(prependText, rawBody, appendText) → string` | Joins the parts with `\n\n`, filtering out empty ones. No video link is inserted — in this app the video is the post's `url`, not text in the body. |

**Rule:** Keep this file free of platform-specific imports. If a function needs to grow a Devvit or browser dependency, move it out of `postUtils.ts` into the appropriate module instead.

---

### `src/episodeChecker.ts`

**Exported functions:**

| Function | Signature | Purpose |
|---|---|---|
| `fetchPlaylistVideos` | `(apiKey, playlistId) → Promise<EpisodeData[]>` | Paginates through the entire playlist (50 items per page) via `nextPageToken`, sorts the combined result by `publishedAt` descending, and returns every item, including private/deleted placeholders. Delegates UC→UU conversion to `resolvePlaylistId` in `postUtils.ts`. |
| `fetchYouTubeVideoById` | `(apiKey, videoId) → Promise<EpisodeData \| null>` | Used by the regeneration flow when the video ID is already known |

**Key detail:** Each playlist page returns up to 50 items in API order, which is not necessarily chronological — the module paginates through every page before sorting the full combined result by `publishedAt`. The Uploads playlist (`UU...`) is always newest-first from the API, making the sort a no-op, but it is kept for correctness when a non-uploads playlist is used. As a playlist's video count grows, this means more pages (and more time) per run — see the `check_new_episodes` flow above for how the registry lookup avoids a matching per-video cost.

**Private video tracking:** Videos with the exact title `"Private video"` (YouTube's placeholder for private/deleted content) are returned by the fetch layer. `check_new_episodes` records them in the video registry with status `private` and does not post them. When such a video later becomes public, it is treated as new. If a newer video is posted in the same run, the formerly-private one keeps its `private` record and is picked up on the next run.

---

### `src/llmClient.ts`

**Exported function:** `generateEpisodePost(apiKey, episode, systemPrompt, geminiModel, thinkingLevel) → Promise<GeneratedPost>`

**API endpoint used:**

```
POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
```

This is the **OpenAI-compatible** endpoint, not the native Gemini endpoint (`/v1beta/models/{model}:generateContent`). The native endpoint contains a colon in the path that Devvit's HTTP proxy misroutes as gRPC. **Do not change this endpoint.**

**Request format:**

```json
{
  "model": "<geminiModel>",
  "messages": [
    { "role": "system", "content": "<systemPrompt>" },
    { "role": "user",   "content": "Title: ...\nPublished: ...\nLink: ...\nDescription: ..." }
  ],
  "max_tokens": 4096,
  "reasoning_effort": "<thinkingLevel, omitted when undefined>"
}
```

**Output parsing convention:** The model's raw text is split on newlines. The first non-empty line becomes the post title; all subsequent lines become the body. The mod's system prompt must instruct the model to output the title on the first line. If the model outputs an empty response, the function throws.

**`finish_reason` guard:** If `finish_reason === 'length'`, a warning is logged. The response is still used; no retry is attempted.

**Deadline and thinking effort:** Devvit caps outgoing HTTP at 30 s and can end the invocation with no log line at all, which is what happens when a thinking model spends too long on a long system prompt. `generateEpisodePost` therefore races the request against a 20 s deadline (`GEMINI_DEADLINE_MS`), logging and throwing on timeout so the job's failure handler PMs mods. `thinkingLevel` (see "Model catalog and thinking levels") is sent as `reasoning_effort`. A model can stop accepting a level after the catalog was built, so a 400 mentioning thinking/reasoning is retried once with the field omitted (model default); any other error throws. Both attempts share the one deadline.

---

### `src/postManager.ts`

**Exported functions:**

| Function | Purpose |
|---|---|
| `createEpisodePost(reddit, subredditName, title, url, body)` | Submits a **link post** (`url` = video) for the native thumbnail/preview card, then posts `body` as a distinguished, stickied top-level comment. Returns `{ postId, commentId }`. |
| `updateEpisodePost(reddit, commentId, body)` | Fetches the discussion comment then calls `.edit({ text: body })` |
| `applyBotFlair(reddit, subredditName, emoji, text)` | Sets author flair on the app's own account; skips if both emoji and text are empty |
| `applyFlair(reddit, subredditName, postId, flairName)` | Case-insensitive flair template name match; logs error and continues if no match found |
| `managePins(reddit, redis, newPostId)` | Reads `last_episode_sticky_slot` from Redis (default: 1), calls `sticky(slot)` on the new post — Reddit atomically displaces the slot occupant so no explicit unsticky is needed. Writes `last_episode_sticky_slot` back to Redis. Fatal if `sticky()` throws. |

**Pin slot:** Defaults to slot `1` on first run. The slot is persisted in Redis under `last_episode_sticky_slot` and can be changed by mods via the "Configure bot" mod menu item. Reddit supports 2 sticky slots per subreddit; `sticky(position)` accepts `1` or `2` and atomically replaces the occupant of that slot.

---

### `src/main.ts`

**Responsibilities:**

- Registers `Devvit.configure` with `redditAPI`, `redis`, and the two HTTP domains
- Declares all installation-scoped settings (see Settings section below)
- Manages the Google API key: stored in Redis under `google_api_key` via the "Configure bot" form (not a Devvit setting, because Devvit settings are readable by mods via the settings UI)
- Manages the Gemini model and thinking level in Redis (`gemini_model`, `gemini_thinking_level`) via "Configure bot"; `getGeminiChoice` reads them for every job
- Registers the `check_new_episodes` scheduler job (the core pipeline)
- Registers the `regenerate_discussion` scheduler job
- Registers the `AppInstall`/`AppUpgrade` trigger (`ensureCheckerScheduled('reset')`: cancel every existing checker cron, schedule a fresh one) and a `PostSubmit`/`CommentSubmit` trigger (`ensureCheckerScheduled('heal')`); every mod menu press also heals. See "Scheduler jobs" for why.
- Registers three subreddit mod menu items — "Configure bot" (API key, pin slot, and an Advanced group with model + thinking-level toggle; then a thinking-level form if toggled), "Check for new videos" (on a Playtest Install, opens a form with Testing Tools), and "Review pending post" (one form: edit, then Publish / Discard / Reject; Discard deletes the pending post and the video's `pending` record, Reject records the video as `rejected`) — and one post mod menu item, "Regenerate discussion" (prompt plus Advanced model/thinking overrides for that run)
- Exports `default Devvit` (required by Devvit platform)

---

## Settings reference

All settings use `SettingScope.Installation`. Each subreddit configures its own values through Mod Tools → Installed Apps.

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `youtubePlaylistId` | string | Yes | — | Playlist ID (`PLxxx`) or channel ID (`UCxxx`) to monitor. Channel IDs are auto-converted to the corresponding Uploads playlist (`UUxxx`). |
| `excludeTitleKeywords` | string | No | `''` | Comma-separated keywords; videos whose titles match any are permanently skipped |
| `systemPrompt` | paragraph | Yes | — | Full system prompt for Gemini. First line of model output = post title |
| `botFlairEmoji` | string | No | `''` | Emoji portion of the bot's author flair |
| `botFlairText` | string | No | `''` | Text portion of the bot's author flair |
| `prependText` | paragraph | No | `''` | Prepended to final post body |
| `appendText` | paragraph | No | `''` | Appended to final post body |
| `flairName` | string | No | `''` | Exact post flair template name (case-insensitive match) |
| `notificationMods` | string | No | `''` | Comma-separated Reddit usernames to notify when a post is queued (e.g. `"alice, bob"`). Each user receives a PM. When blank, notification goes to the general mod inbox via `createModInboxConversation`. Only applies when `requireModApproval` is true. |
| `requireModApproval` | boolean | No | `false` | When true, generated posts are stored in Redis, the video is recorded as `pending`, and a notification is sent instead of posting immediately. While a post is pending, checks skip generation entirely. Mods use the "Review pending post" form to publish, discard, or reject. |
| `autoApproveWindowMinutes` | number | No | `0` | Only applies when `requireModApproval` is true. When > 0, schedules a `post_pending_episode` job to auto-publish after this many minutes if no mod acts first. Set to `0` for indefinite hold. |

The Google API key (`google_api_key`) is **not** a Devvit setting. It is stored directly in Redis via the "Configure bot" mod menu form, keeping it out of the visible Devvit settings UI.

---

## Redis state

| Key | Type | Written by | Read by | Purpose |
|---|---|---|---|---|
| `google_api_key` | string | "Configure bot" form | `check_new_episodes`, `regenerate_discussion` | Google API key for both YouTube and Gemini |
| `video_registry` | hash | `check_new_episodes` (step 4, 11), `post_pending_episode`, "Review pending post" form (Discard / Reject) | `check_new_episodes` (step 4), "Regenerate discussion" (`findVideoByPostId`) | Hash of videoId → `VideoRecord` JSON. Tracks every seen video with status `posted`, `pending`, `excluded`, `rejected`, `skipped`, or `private`. `posted` is terminal: `setVideoRecord` ignores non-`posted` writes over it and `deleteVideoRecord` refuses to remove it. |
| `last_episode_sticky_slot` | string (`'1'`–`'2'`) | `managePins`, "Configure bot" form | `managePins`, "Configure bot" form | Sticky slot the bot uses for episode posts. Written by `managePins` after each successful pin, and directly by the "Configure bot" form. Defaults to `1` if absent. |
| `gemini_model` | string | "Configure bot" form (deleted when "Recommended" is chosen) | `getGeminiChoice` (all Gemini jobs, both forms) | Advanced model override. Absent = `DEFAULT_GEMINI_MODEL`. |
| `gemini_thinking_level` | string (`ThinkingLevel`) | "Configure bot" thinking-level form; deleted when the toggle is off or the model changes | `getGeminiChoice` | Advanced thinking override. Absent, or not accepted by the model = no `reasoning_effort`. |
| `regenerate_draft:<userId>` | string (JSON `RegenerateJobData`), 1 h expiry | "Regenerate discussion" step 1 | "Regenerate discussion" step 2 (then deleted) | Carries step 1's answers to the thinking-level step. |
| `episode_checker_job_id` | string | `ensureCheckerScheduled` | — | ID of the current checker cron job, for debugging. The scheduler's `listJobs()` is the source of truth. |
| `episode_checker_verified_at` | string (epoch ms) | `ensureCheckerScheduled` | `ensureCheckerScheduled` | When the checker job was last verified; throttles 'heal' to once per 30 minutes. |
| `check_triggered_by` | string | "Check for new videos" menu item / playtest form | `check_new_episodes` (manual-run outcome PMs and error handler), `post_pending_episode` error handler (when no `triggeredBy` job data) | Username of the mod who manually triggered; used to PM outcomes and failures |
| `pending_post` | string (JSON) | `check_new_episodes` (approval gate path), "Review pending post" form (Publish writes edits back) | `check_new_episodes` (skips generation while set), `post_pending_episode`, "Review pending post" menu item and form | Serialised `PendingPost` object holding generated title, body, url, videoId, videoTitle, and generatedAt timestamp. Deleted when the post is published, discarded, or rejected. |
| `pending_post_job_id` | string | `check_new_episodes` (when `autoApproveWindowMinutes > 0`) | "Review pending post" form | Scheduler job ID for the auto-approve timer. Cancelled and deleted when a mod acts first. |

Keys no longer written (may linger on older installs, safe to delete): `last_episode_guid`, `last_episode_post_id`, `last_episode_comment_id`, `force_repost`, `regenerate_triggered_by`.

**Resetting state:** On a Playtest Install, tick the force-repost Testing Tool in the "Check for new videos" form to repost the newest video. To manually clear a video from the registry, delete its field from the `video_registry` hash in Redis.

---

## Scheduler jobs

| Job name | Schedule | Trigger |
|---|---|---|
| `check_new_episodes` | `*/30 * * * *` (cron) | Kept alive by `ensureCheckerScheduled` (see below). Also triggered immediately by "Check for new videos" via `runAt: new Date()` with job data `{ forceRepost, manual: true }` (`forceRepost` is `true` only from the playtest form). A manual run always ends visibly for the mod: a new post, a failure PM, or a PM saying why nothing was posted (missing settings, no videos, nothing new, post awaiting approval). Cron runs stay silent in those cases. |
| `post_pending_episode` | No fixed schedule | Triggered immediately by the "Review pending post" form's Publish action with job data `{ triggeredBy }`, so a failure PMs the mod who pressed it. Also scheduled at `now + autoApproveWindowMinutes` by `check_new_episodes` when `requireModApproval` is true and a window is configured. |
| `regenerate_discussion` | No fixed schedule | Only triggered by the "Regenerate discussion" post menu forms via `runAt: new Date()`, with job data `{ videoId, commentId, systemPrompt, model, thinkingLevel, triggeredBy }`. |

Blocks apps cannot declare a cron in `devvit.json` (`scheduler.tasks` requires a `server` entry point), so the checker cron is created at runtime by `ensureCheckerScheduled` in `src/checkerSchedule.ts`. On `AppInstall`/`AppUpgrade` it runs in `'reset'` mode: cancel every `check_new_episodes` cron and schedule a fresh one, so a job from an older version is replaced. Those events alone proved unreliable — a playtest install was found with no job, no stored job ID, and no trigger log across six version changes — so `'heal'` mode also runs on every mod menu press and on `PostSubmit`/`CommentSubmit`. Heal is throttled to once per 30 minutes via `episode_checker_verified_at`, schedules the job only if `listJobs()` has none, and cancels duplicates left by concurrent heals. It never throws.

---

## Devvit platform constraints to keep in mind

1. **HTTP domains must be pre-declared.** `youtube.googleapis.com` and `generativelanguage.googleapis.com` are registered in both `devvit.json` and `Devvit.configure`. Adding a new external API requires adding it to both locations.

2. **No colons in URL paths via the HTTP proxy.** The Gemini native endpoint (`/v1beta/models/{model}:generateContent`) contains a colon that the Devvit proxy misroutes. Always use the OpenAI-compatible endpoint at `/v1beta/openai/chat/completions`.

3. **`context.subredditName` is the source of truth for the subreddit name.** There is no `subredditName` setting. Do not add one.

4. **Scheduler jobs run in the Devvit cloud, not in the user's browser.** `context.ui` (toasts, forms) is not available inside scheduler job `onRun` handlers. Only mod menu `onPress` handlers can call `context.ui.*`.

5. **`SettingScope.Installation` is required** for all per-subreddit settings. `SettingScope.App` is for developer-owned secrets shared across all installs — deliberately not used here.

6. **Link posts (`url`) and self-post bodies (`text`/`richtext`) are mutually exclusive on Reddit** — this is a platform-level constraint in Reddit's data model, not a Devvit limitation, and it isn't fixable from the app. Confirmed dead ends, do not re-attempt: a richtext `embed` node pointing at the video is silently stripped by Reddit (the post comes back with an empty body); a bare video URL on its own line in self-post markdown text does not get Reddit's auto-embed preview card, it just renders as a plain link. The only way to get both the native video thumbnail/preview card and the full discussion text is what this app does — submit a genuine link post (`url` = video) and post the discussion body separately as a distinguished, stickied top-level comment (see `createEpisodePost` in `postManager.ts`).

---

## Logging conventions

All log lines are prefixed with a bracketed module tag so they're filterable in `devvit logs`:

| Prefix | Source |
|---|---|
| `[bot]` | `main.ts` scheduler job handlers |
| `[llmClient]` | `llmClient.ts` |
| `[postManager]` | `postManager.ts` |

Errors use `console.error`; informational output uses `console.log`; warnings use `console.warn`. Error paths inside `catch` blocks log the error and either return (non-fatal) or rethrow (fatal — e.g., pin failure in `managePins`).

**Missing log lines don't mean a job died.** Observed on a playtest install (2026-10-14): `devvit logs` (live and `--since`) kept a scheduler job's first ~4 s of output, then nothing, while the job kept running and finished (the discussion comment updated). A fast job (3.5 s) logged completely. So don't diagnose timeouts from where logs stop; check the visible outcome (post, comment, or PM). Mods get either the result or a PM, by design, which is why every manual action must end in one of the two.

---

## How to make common changes

### Add a new installation setting

1. Add the setting definition to `Devvit.addSettings([...])` in `src/main.ts`.
2. Read it in the `check_new_episodes` `onRun` handler alongside the other settings reads.
3. Pass it as a parameter to the relevant module function.
4. Update the Settings reference table in this file and in `README.md`.

### Change the Gemini model or request parameters

Edit `generateEpisodePost` in `src/llmClient.ts`. The `model`, `max_tokens`, and `reasoning_effort` fields are in the JSON body. Model and thinking level come from Redis via `getGeminiChoice` in `src/main.ts`, so mods change them in "Configure bot" without a code deploy. To refresh the models on offer, run `npm run models:sync` and commit `src/geminiModels.generated.ts`. Keep `GEMINI_DEADLINE_MS` comfortably under Devvit's 30 s HTTP limit.

### Change the post body assembly order

The body is assembled by `assemblePostBody` in `src/postUtils.ts`. It becomes the discussion comment, not the post text — the post itself only ever gets `title` and `url` (see `createEpisodePost`). Both `check_new_episodes` and `regenerate_latest_post` in `src/main.ts` call `assemblePostBody`, as does the preview web app. Edit the function there and the change applies everywhere.

### Add a new mod menu item

Use `Devvit.addMenuItem` in `src/main.ts`. For actions that take time, schedule a one-off job with `runAt: new Date()` and show a confirmation toast — do not run long operations directly inside `onPress`.

- Keep `description` to a short phrase: Reddit renders every description in the subreddit's "…" menu (where subreddit menu items appear, next to the Mod Tools button), so long ones make the menu grow. When pointing mods at a menu item in a message, say "the subreddit's "…" menu", not "Mod Tools".
- Mods cannot read app logs. Never tell them to "check logs". Toasts say what they'll see (e.g. "The post appears within 30 seconds; otherwise you'll get a message"), and the job must make that true: PM the triggering mod on failure, and on any outcome that would otherwise be invisible.

### Change the pin rotation behavior

`managePins` in `src/postManager.ts` reads `last_episode_sticky_slot` from Redis (default `1`), calls `sticky(slot)` on the new post, and writes the slot back to Redis. Reddit's `sticky()` atomically displaces the existing occupant of that slot — no explicit `unsticky()` is needed. To change which slot is used at runtime, mods can use the "Set pin slot" mod menu item, which writes directly to `last_episode_sticky_slot`.

### Support multiple playlists

Currently one playlist ID per subreddit installation. To fan out, the `check_new_episodes` job would need to accept a list of IDs and call `fetchLatestYouTubeEpisode` once per ID, with separate deduplication keys per playlist.

---

## TypeScript and build notes

- Module system: `"type": "module"` in `package.json`. All imports use `.js` extensions (even for `.ts` source files) per Node ESM + TypeScript bundler conventions.
- `tsconfig.json` uses `"moduleResolution": "Bundler"` (Devvit requirement).
- Compiled `.js` files are **not committed** (`src/*.js` is gitignored). Devvit compiles TypeScript during `devvit upload`. Run `npm run type-check` to verify types locally before deploying.
- `npm run type-check` (`tsc --build`) **does emit** `.js` next to each source. Bundlers resolve `./x.js` imports to those files when they exist, so a stale `src/geminiModels.generated.js` would win over a freshly synced `.ts`. `predeploy` therefore runs `models:sync` and then `type-check`; re-run `type-check` after a manual sync too.
- The `devDependencies` include `dotenv-cli` to inject a `.env` file during `devvit playtest` (the `dev` script). Create a `.env` file if needed for local playtest overrides — it is gitignored.
- **Devvit releases frequently.** Before starting work, check for a newer version of `@devvit/public-api` and `devvit` by running `npm outdated @devvit/public-api devvit`. If a newer version is available, update both packages (`npm install @devvit/public-api@latest devvit@latest`) and run `npm run type-check` to catch any breaking changes before making other modifications.

---

## Commands

| Command | Effect |
|---|---|
| `npm run dev` | `devvit playtest` — installs to test subreddit, streams live logs |
| `npm run deploy` | `devvit upload` — uploads to App Directory (not yet published) |
| `npm run launch` | `devvit publish` — publishes the app publicly |
| `npm run type-check` | TypeScript type check (also emits `.js` next to sources; see build notes) |
| `npm run models:sync` | Refresh `src/geminiModels.generated.ts` from the Gemini API (needs `GEMINI_API_KEY` in `.env`); runs automatically before `deploy` |

---

## Preview web app (`preview-site/`)

A React + Vite SPA that lets mods preview what Gemini will generate before deploying the bot. It is a pure client-side app — no server required.

**Shared code:** The preview app imports types from `src/types.ts`, the utilities from `src/postUtils.ts`, and the model catalog helpers from `src/geminiModels.ts` via the `@shared` path alias (configured in `preview-site/vite.config.ts` and `tsconfig.json`). Its model list is the same build-time catalog the bot offers, and the thinking-level select appears only for models that accept more than one level; the chosen level is sent as `thinkingConfig.thinkingLevel` (`none` → `thinkingBudget: 0`) on the native SDK. **Never re-declare these types or functions inside the preview app** — edit the shared source.

**Netlify deployment:** Configured in `netlify.toml` at the repo root. Base dir is `preview-site`, publish dir is `dist`. Do **not** set `GEMINI_API_KEY` as a Netlify env var — it would be baked into the public JS bundle. Users supply their own key via the UI; it is stored in `localStorage`.

**Preview app commands** (run from `preview-site/`):

| Command | Effect |
|---|---|
| `npm run dev` | Vite dev server on port 3000 |
| `npm run build` | Production build to `dist/` |
| `npm run lint` | TypeScript type check (no emit) |

---

## What not to change without careful review

- **The Gemini HTTP endpoint URL** in `llmClient.ts` — the OpenAI-compatible path is required by the Devvit HTTP proxy.
- **The `*/30 * * * *` cron expression** — Devvit enforces a minimum polling interval for scheduled jobs; going below 30 minutes may be rejected.
- **`ensureCheckerScheduled` and its callers** — the install/upgrade `'reset'` plus the activity/menu `'heal'` are what keep the cron alive; removing either leaves installs silently never checking for videos.
- **The Redis key names** — changing them invalidates deduplication state for all existing installs mid-operation.
- **`export default Devvit`** in `main.ts` — required by the Devvit runtime entry point contract.
- **The signatures of exported functions in `src/postUtils.ts`** — both the Devvit app and the preview web app call these functions. A signature change must be applied to both call sites simultaneously.
- **The link post + stickied discussion comment pattern** in `createEpisodePost` — don't revert to a self post with an embedded video link. Reddit's post model cannot carry both a `url` (needed for the thumbnail/preview card) and a `text` body at the same time; see platform constraint #6 above.

---

## All Devvit Capabilities

The full documentation can be found via <https://developers.reddit.com/docs/llms-full.txt>
