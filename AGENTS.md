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
                    and the AppInstall/AppUpgrade trigger. Owns the top-level orchestration loop.
  episodeChecker.ts YouTube Data API v3 client. Fetches playlists and individual
                    videos. Contains the exclusion-keyword filter.
  llmClient.ts      Gemini API client (via OpenAI-compatible endpoint). Delegates
                    message building and response parsing to postUtils.ts.
  postManager.ts    Reddit operations: link post submission with a distinguished, stickied
                    discussion comment, flair application, bot author flair, comment editing,
                    and pin rotation.
  postUtils.ts      Platform-agnostic pure utilities shared with the preview web app:
                    resolvePlaylistId, buildUserMessage, parseGeneratedResponse,
                    assemblePostBody. No Devvit or browser dependencies — safe to
                    import from both runtimes.
  videoRegistry.ts  Redis hash-backed registry of every video the bot has seen.
                    Stores status (posted/excluded/skipped) and postId/commentId per video ID.
  types.ts          Shared interfaces: EpisodeData, GeneratedPost, VideoRecord.

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
AppInstall / AppUpgrade trigger
  └─► scheduler.runJob('check_new_episodes', cron='*/30 * * * *')

check_new_episodes job (src/main.ts)
  │
  ├─ 1. Read all settings (concurrently) + Google API key from Redis
  ├─ 2. Validate: googleApiKey, youtubePlaylistId, systemPrompt required
  │
  ├─ 3. In parallel: fetchPlaylistVideos, force_repost flag, and the whole
  │     video registry (getAllVideoRecords — one hGetAll, not one hGet per
  │     video)                                    episodeChecker.ts, videoRegistry.ts
  │       UC... channel ID is auto-converted to UU... uploads playlist
  │       GET playlistItems (maxResults=50, paginated) → sort by publishedAt (desc)
  │       → return EpisodeData[]
  │
  ├─ 4. For each video newest-first:                            videoRegistry.ts
  │       a. Check force_repost flag — if set, skip registry for first video only
  │       b. Look up videoRecords[video.guid] (pre-fetched) → skip if already registered
  │       c. matchesExclusionFilter(title, excludeKeywords)     episodeChecker.ts
  │            → if matched: setVideoRecord(..., 'excluded'), continue
  │       d. First unregistered non-excluded video = episodeToPost
  │          Remaining unregistered videos → setVideoRecord(..., 'skipped')
  │
  ├─ 5. generateEpisodePost(apiKey, episode, systemPrompt, model)  llmClient.ts
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
                  redis.set('last_episode_guid', episode.guid)   ← legacy compat
                  redis.set('last_episode_post_id', postId)
                  redis.set('last_episode_comment_id', commentId)
```

### Regeneration flow (mod menu → "Regenerate latest post")

Re-runs Gemini for the already-processed video and calls `updateEpisodePost` to edit the existing discussion comment's body text (the post itself is a link post with no editable body). Does **not** re-submit, re-flair, or re-pin. Uses `fetchYouTubeVideoById` (looks up by video ID directly) rather than the playlist. Reads `last_episode_comment_id` — a post created before this comment-based flow shipped has no tracked comment and cannot be regenerated; the job logs an error and returns.

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
| `isPrivateVideo` | `(video) → boolean` | Returns true if the video title is exactly `"Private video"` — YouTube's placeholder for private/deleted content. Used by `episodeChecker.ts` to filter at the fetch layer. |
| `assemblePostBody` | `(prependText, rawBody, appendText) → string` | Joins the parts with `\n\n`, filtering out empty ones. No video link is inserted — in this app the video is the post's `url`, not text in the body. |

**Rule:** Keep this file free of platform-specific imports. If a function needs to grow a Devvit or browser dependency, move it out of `postUtils.ts` into the appropriate module instead.

---

### `src/episodeChecker.ts`

**Exported functions:**

| Function | Signature | Purpose |
|---|---|---|
| `fetchPlaylistVideos` | `(apiKey, playlistId) → Promise<EpisodeData[]>` | Paginates through the entire playlist (50 items per page) via `nextPageToken`, sorts the combined result by `publishedAt` descending, filters out private/deleted videos via `isPrivateVideo`, and returns the rest as an array. Delegates UC→UU conversion to `resolvePlaylistId` in `postUtils.ts`. |
| `fetchYouTubeVideoById` | `(apiKey, videoId) → Promise<EpisodeData \| null>` | Used by the regeneration flow when the video ID is already known |

**Key detail:** Each playlist page returns up to 50 items in API order, which is not necessarily chronological — the module paginates through every page before sorting the full combined result by `publishedAt`. The Uploads playlist (`UU...`) is always newest-first from the API, making the sort a no-op, but it is kept for correctness when a non-uploads playlist is used. As a playlist's video count grows, this means more pages (and more time) per run — see the `check_new_episodes` flow above for how the registry lookup avoids a matching per-video cost.

**Private video filtering:** Videos with the exact title `"Private video"` (YouTube's placeholder for private/deleted content) are automatically filtered out at the fetch layer using `isPrivateVideo` from `postUtils.ts`. They never reach the processing loop and are not recorded in the video registry.

---

### `src/llmClient.ts`

**Exported function:** `generateEpisodePost(apiKey, episode, systemPrompt, geminiModel) → Promise<GeneratedPost>`

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
  "max_tokens": 4096
}
```

**Output parsing convention:** The model's raw text is split on newlines. The first non-empty line becomes the post title; all subsequent lines become the body. The mod's system prompt must instruct the model to output the title on the first line. If the model outputs an empty response, the function throws.

**`finish_reason` guard:** If `finish_reason === 'length'`, a warning is logged. The response is still used; no retry is attempted.

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

**Pin slot:** Defaults to slot `1` on first run. The slot is persisted in Redis under `last_episode_sticky_slot` and can be changed by mods via the "Set pin slot" mod menu item. Reddit supports 2 sticky slots per subreddit; `sticky(position)` accepts `1` or `2` and atomically replaces the occupant of that slot.

---

### `src/main.ts`

**Responsibilities:**

- Registers `Devvit.configure` with `redditAPI`, `redis`, and the two HTTP domains
- Declares all installation-scoped settings (see Settings section below)
- Manages the Google API key: stored in Redis under `google_api_key` via a mod-triggered form (not a Devvit setting, because Devvit settings are readable by mods via the settings UI)
- Registers the `check_new_episodes` scheduler job (the core pipeline)
- Registers the `regenerate_latest_post` scheduler job
- Registers the `AppInstall`/`AppUpgrade` trigger (schedules the cron, cancels any previous job first for idempotency — fires on both initial install and every subsequent version upgrade, since dynamically-created cron jobs are not guaranteed to survive every deploy)
- Registers five mod menu items: "Set Google API Key", "Set pin slot", "Check for new videos", "Force post latest video (testing)", and "Regenerate latest post"
- Exports `default Devvit` (required by Devvit platform)

---

## Settings reference

All settings use `SettingScope.Installation`. Each subreddit configures its own values through Mod Tools → Installed Apps.

| Key | Type | Required | Default | Notes |
|---|---|---|---|---|
| `youtubePlaylistId` | string | Yes | — | Playlist ID (`PLxxx`) or channel ID (`UCxxx`) to monitor. Channel IDs are auto-converted to the corresponding Uploads playlist (`UUxxx`). |
| `excludeTitleKeywords` | string | No | `''` | Comma-separated keywords; videos whose titles match any are permanently skipped |
| `geminiModel` | string | No | `gemini-2.0-flash` | Any model ID supported by the OpenAI-compat endpoint |
| `systemPrompt` | paragraph | Yes | — | Full system prompt for Gemini. First line of model output = post title |
| `botFlairEmoji` | string | No | `''` | Emoji portion of the bot's author flair |
| `botFlairText` | string | No | `''` | Text portion of the bot's author flair |
| `prependText` | paragraph | No | `''` | Prepended to final post body |
| `appendText` | paragraph | No | `''` | Appended to final post body |
| `flairName` | string | No | `''` | Exact post flair template name (case-insensitive match) |
| `notificationMods` | string | No | `''` | Comma-separated Reddit usernames to notify when a post is queued (e.g. `"alice, bob"`). Each user receives a PM. When blank, notification goes to the general mod inbox via `createModInboxConversation`. Only applies when `requireModApproval` is true. |
| `requireModApproval` | boolean | No | `false` | When true, generated posts are stored in Redis and a notification is sent instead of posting immediately. Mods use the "Post pending episode" or "Edit & Post pending episode" menu items to publish. |
| `autoApproveWindowMinutes` | number | No | `0` | Only applies when `requireModApproval` is true. When > 0, schedules a `post_pending_episode` job to auto-publish after this many minutes if no mod acts first. Set to `0` for indefinite hold. |

The Google API key (`google_api_key`) is **not** a Devvit setting. It is stored directly in Redis via the "Set Google API Key" mod menu form, keeping it out of the visible Devvit settings UI.

---

## Redis state

| Key | Type | Written by | Read by | Purpose |
|---|---|---|---|---|
| `google_api_key` | string | `apiKeyForm` handler | `check_new_episodes`, `regenerate_latest_post` | Google API key for both YouTube and Gemini |
| `video_registry` | hash | `check_new_episodes` (step 4, 11) | `check_new_episodes` (step 4) | Hash of videoId → `VideoRecord` JSON. Tracks every seen video with status `posted`, `excluded`, `skipped`, or `private`. |
| `last_episode_guid` | string | `check_new_episodes` (step 11), `post_pending_episode` | `regenerate_latest_post` | Legacy: YouTube video ID of last posted video — kept for backwards compatibility |
| `last_episode_post_id` | string | `check_new_episodes` (step 11), `post_pending_episode` | — | Reddit post ID of the currently pinned link post |
| `last_episode_comment_id` | string | `check_new_episodes` (step 11), `post_pending_episode` | `regenerate_latest_post` | Reddit comment ID of the discussion comment under the currently pinned post. Posts created before this field existed have no tracked comment and cannot be regenerated. |
| `last_episode_sticky_slot` | string (`'1'`–`'2'`) | `managePins`, `pinSlotForm` handler | `managePins` | Sticky slot the bot uses for episode posts. Written by `managePins` after each successful pin, and directly by the "Set pin slot" mod menu form. Defaults to `1` if absent. |
| `episode_checker_job_id` | string | `AppInstall`/`AppUpgrade` trigger | `AppInstall`/`AppUpgrade` trigger | Scheduler job ID, used to cancel and re-create on reinstall or upgrade |
| `force_repost` | string (`'1'`) | "Force post latest video" menu item | `check_new_episodes` (step 4a) | One-shot flag: skip registry check for the newest video on the next run. Deleted immediately when read. |
| `check_triggered_by` | string | "Check for new videos" / "Force post" menu items | `check_new_episodes` error handler, `post_pending_episode` error handler | Username of the mod who manually triggered; used to send a PM on failure |
| `regenerate_triggered_by` | string | "Regenerate latest post" menu item | `regenerate_latest_post` error handler | Username of the mod who triggered regeneration; used to send a PM on failure |
| `pending_post` | string (JSON) | `check_new_episodes` (approval gate path) | `post_pending_episode`, "Post pending episode" / "Edit & Post" / "Cancel" menu items | Serialised `PendingPost` object holding generated title, body, url, videoId, videoTitle, and generatedAt timestamp. Deleted when the post goes live or is cancelled. |
| `pending_post_job_id` | string | `check_new_episodes` (when `autoApproveWindowMinutes > 0`) | "Post pending episode" / "Edit & Post" / "Cancel" menu items | Scheduler job ID for the auto-approve timer. Cancelled and deleted when a mod acts first. |

**Resetting state:** To force a repost of the latest video, use the "Force post latest video (testing)" mod menu item. To manually clear a video from the registry, delete its field from the `video_registry` hash in Redis.

---

## Scheduler jobs

| Job name | Schedule | Trigger |
|---|---|---|
| `check_new_episodes` | `*/30 * * * *` (cron) | Scheduled at `AppInstall` and `AppUpgrade`. Also triggered immediately by "Check for new videos" mod menu item via `runAt: new Date()` |
| `post_pending_episode` | No fixed schedule | Triggered immediately by "Post pending episode" and "Edit & Post pending episode" menu items. Also scheduled at `now + autoApproveWindowMinutes` by `check_new_episodes` when `requireModApproval` is true and a window is configured. |
| `regenerate_latest_post` | No fixed schedule | Only triggered by "Regenerate latest post" mod menu item via `runAt: new Date()` |

The `AppInstall`/`AppUpgrade` trigger cancels any existing job ID before scheduling a new one, making reinstalls and version upgrades idempotent. This runs on *every* version upgrade (not just first install) because Devvit does not guarantee dynamically-created cron jobs survive each deploy — without the `AppUpgrade` leg, a mod updating the app version could silently lose the recurring job with no automatic recovery.

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

---

## How to make common changes

### Add a new installation setting

1. Add the setting definition to `Devvit.addSettings([...])` in `src/main.ts`.
2. Read it in the `check_new_episodes` `onRun` handler alongside the other settings reads.
3. Pass it as a parameter to the relevant module function.
4. Update the Settings reference table in this file and in `README.md`.

### Change the Gemini model or request parameters

Edit `generateEpisodePost` in `src/llmClient.ts`. The `model` and `max_tokens` fields are in the JSON body. The `model` value comes from the `geminiModel` installation setting so mods can change it without a code deploy.

### Change the post body assembly order

The body is assembled by `assemblePostBody` in `src/postUtils.ts`. It becomes the discussion comment, not the post text — the post itself only ever gets `title` and `url` (see `createEpisodePost`). Both `check_new_episodes` and `regenerate_latest_post` in `src/main.ts` call `assemblePostBody`, as does the preview web app. Edit the function there and the change applies everywhere.

### Add a new mod menu item

Use `Devvit.addMenuItem` in `src/main.ts`. For actions that take time, schedule a one-off job with `runAt: new Date()` and show a confirmation toast — do not run long operations directly inside `onPress`.

### Change the pin rotation behavior

`managePins` in `src/postManager.ts` reads `last_episode_sticky_slot` from Redis (default `1`), calls `sticky(slot)` on the new post, and writes the slot back to Redis. Reddit's `sticky()` atomically displaces the existing occupant of that slot — no explicit `unsticky()` is needed. To change which slot is used at runtime, mods can use the "Set pin slot" mod menu item, which writes directly to `last_episode_sticky_slot`.

### Support multiple playlists

Currently one playlist ID per subreddit installation. To fan out, the `check_new_episodes` job would need to accept a list of IDs and call `fetchLatestYouTubeEpisode` once per ID, with separate deduplication keys per playlist.

---

## TypeScript and build notes

- Module system: `"type": "module"` in `package.json`. All imports use `.js` extensions (even for `.ts` source files) per Node ESM + TypeScript bundler conventions.
- `tsconfig.json` uses `"moduleResolution": "Bundler"` (Devvit requirement).
- Compiled `.js` files are **not committed** (`src/*.js` is gitignored). Devvit compiles TypeScript during `devvit upload`. Run `npm run type-check` to verify types locally before deploying.
- The `devDependencies` include `dotenv-cli` to inject a `.env` file during `devvit playtest` (the `dev` script). Create a `.env` file if needed for local playtest overrides — it is gitignored.
- **Devvit releases frequently.** Before starting work, check for a newer version of `@devvit/public-api` and `devvit` by running `npm outdated @devvit/public-api devvit`. If a newer version is available, update both packages (`npm install @devvit/public-api@latest devvit@latest`) and run `npm run type-check` to catch any breaking changes before making other modifications.

---

## Commands

| Command | Effect |
|---|---|
| `npm run dev` | `devvit playtest` — installs to test subreddit, streams live logs |
| `npm run deploy` | `devvit upload` — uploads to App Directory (not yet published) |
| `npm run launch` | `devvit publish` — publishes the app publicly |
| `npm run type-check` | TypeScript type check only, no emit |

---

## Preview web app (`preview-site/`)

A React + Vite SPA that lets mods preview what Gemini will generate before deploying the bot. It is a pure client-side app — no server required.

**Shared code:** The preview app imports `EpisodeData`, `GeneratedPost` from `src/types.ts` and all four utilities from `src/postUtils.ts` via the `@shared` path alias (configured in `preview-site/vite.config.ts` and `tsconfig.json`). **Never re-declare these types or functions inside the preview app** — edit the shared source.

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
- **The `AppInstall`/`AppUpgrade` trigger's cancel-before-reschedule pattern** — removing either event causes duplicate jobs on reinstall or a silently-dead cron job after a version upgrade.
- **The Redis key names** — changing them invalidates deduplication state for all existing installs mid-operation.
- **`export default Devvit`** in `main.ts` — required by the Devvit runtime entry point contract.
- **The signatures of exported functions in `src/postUtils.ts`** — both the Devvit app and the preview web app call these functions. A signature change must be applied to both call sites simultaneously.
- **The link post + stickied discussion comment pattern** in `createEpisodePost` — don't revert to a self post with an embedded video link. Reddit's post model cannot carry both a `url` (needed for the thumbnail/preview card) and a `text` body at the same time; see platform constraint #6 above.

---

## All Devvit Capabilities

The full documentation can be found via <https://developers.reddit.com/docs/llms-full.txt>
