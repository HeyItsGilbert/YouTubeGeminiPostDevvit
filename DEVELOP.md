# Developer Setup

## Project structure

```
src/
  main.ts              -- Entry point: settings, scheduler, triggers, menu actions
  episodeChecker.ts    -- YouTube Data API: fetch latest video from playlist
  llmClient.ts         -- Gemini API: generate post with mod-supplied prompt
  geminiModels.ts      -- Shared model catalog helpers: ordering, default model,
                          accepted thinking levels
  geminiModels.generated.ts -- Model catalog written by `npm run models:sync`
  postManager.ts       -- Reddit post creation, flair, pin management
  postUtils.ts         -- Shared pure utilities (no Devvit/browser deps):
                          resolvePlaylistId, buildUserMessage,
                          parseGeneratedResponse, assemblePostBody
  videoRegistry.ts     -- Redis-backed registry of processed videos
  types.ts             -- Shared TypeScript types (EpisodeData, GeneratedPost, VideoRecord, GeminiModel)

scripts/sync-gemini-models.mjs -- Refreshes the Gemini model catalog
preview-site/  -- React + Vite preview web app (deployed to Netlify)
netlify.toml                  -- Netlify deploy config (base: preview-site/)
```

## 1. Install dependencies

```bash
npm install
```

## 2. Start a playtest session

```bash
npm run dev
```

This installs the app to your test subreddit and streams logs.

## 3. Configure the bot

Each subreddit stores its own Google API key and Gemini model via a mod menu action.

1. Navigate to your subreddit.
2. Open the subreddit's **"…"** menu (next to Mod Tools) and select **Configure bot**.
3. Paste your key, pick a pin slot, and click **Save**.
4. Optional, under **Advanced**: override the Gemini model (default `gemini-flash-latest`) or turn on **Choose a thinking level** to pick one on the next screen.

The key is stored in the subreddit's Redis store. To get a key, visit the visit the [AI Studio](https://aistudio.google.com/), create a project and API key. Then go to [Google Cloud Console](https://console.cloud.google.com/), switch to the new project, and enable both the **YouTube Data API v3**.

## 4. Configure installation settings

In your subreddit's app settings page (Mod Tools > Installed Apps), configure:

- **YouTube Playlist ID** -- The ID of the playlist to monitor (the part after `list=` in the URL).
- **System Prompt** -- Instructions for Gemini that control the voice and format of generated posts. The user message will include: **Title**, **Published**, **Link**, and **Description** — reference these in your prompt. See `SystemPrompt.example.md` for a sample.
- **Video Link Label** (optional) -- A label for an auto-inserted link to the YouTube video, placed after the generated body. E.g. `Watch on YouTube` produces `[Watch on YouTube](url)`. Leave blank to omit.
- **Prepend Text** (optional) -- Text added to the top of every post body (e.g. a recurring link or disclaimer).
- **Append Text** (optional) -- Text added to the bottom of every post body (e.g. a footer or recurring links).
- **Post Flair** (optional) -- The exact name of a post flair template on your subreddit.
- **Hold posts for mod approval** (optional) -- When enabled, generated posts are queued for mod review instead of posting immediately. Use the mod menu items to publish, edit, or cancel.
- **Auto-approve window** (optional) -- Minutes to wait before auto-publishing a queued post if no mod acts. Set to 0 for indefinite hold. Only applies when mod approval is enabled.
- **Notification Recipients** (optional) -- Comma-separated Reddit usernames to notify when a post is queued (e.g. `alice, bob`). Falls back to general mod inbox when blank.

## 5. HTTP domains

Both `youtube.googleapis.com` and `generativelanguage.googleapis.com` are on the Devvit global allowlist. No additional domain approval is needed.

## 6. Gemini model catalog

The models offered in **Configure bot**, **Regenerate discussion**, and the
preview site come from `src/geminiModels.generated.ts`, which is committed.
`npm run models:sync` rebuilds it: it lists the Gemini models, then probes
each thinking model once per `reasoning_effort` level to record which levels
it accepts. `npm run deploy` runs it (and the type check) first.

It needs a Gemini API key in the root `.env`:

```bash
GEMINI_API_KEY=your-key
```

A probe that is rate-limited or otherwise inconclusive keeps the model's
levels from the previous catalog. Commit the regenerated file.

# Commands

| Command              | Description                                             |
|----------------------|---------------------------------------------------------|
| `npm run dev`        | Playtest -- installs to test subreddit and streams logs |
| `npm run deploy`     | Upload app to the App Directory                         |
| `npm run launch`     | Publish the app                                         |
| `npm run type-check` | TypeScript type check                                   |
| `npm run models:sync`| Refresh the Gemini model catalog (needs `GEMINI_API_KEY`) |

# Redis keys

| Key                       | Purpose                                                          |
|---------------------------|------------------------------------------------------------------|
| `google_api_key`          | Google API key (set via mod menu, not stored in settings)        |
| `video_registry`          | Hash of videoId → VideoRecord JSON (deduplication + status)      |
| `last_episode_guid`       | Video ID of last posted video (legacy, kept for compat)          |
| `last_episode_post_id`    | Reddit post ID of currently pinned post                          |
| `episode_checker_job_id`  | Scheduler job ID (used for clean re-install)                     |
| `force_repost`            | One-shot flag: skip registry check for newest video next run     |
| `check_triggered_by`      | Mod username — used to PM on failure after manual trigger        |
| `regenerate_triggered_by` | Mod username — used to PM on failure after regeneration trigger  |
| `pending_post`            | JSON blob of queued post (title, body, url, videoId, etc.)       |
| `pending_post_job_id`     | Scheduler job ID for the auto-approve timer                      |
| `gemini_model`            | Gemini model chosen in Configure bot                             |
| `gemini_thinking_level`   | Thinking level chosen in Configure bot                           |
| `regenerate_draft:<userId>` | Regenerate form step 1 answers, read by step 2 (1 h expiry)    |

# Learn more

- [Devvit documentation](https://developers.reddit.com/docs/)
- [Developer portal](https://developers.reddit.com/my/apps)
