# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-10-14

### Added

- Optional **Advanced** overrides in **Configure bot**: pick a specific Gemini
  model, and turn on **Choose a thinking level** to pick from the levels that
  model accepts on the next screen. The model list and each model's levels
  are refreshed from the Gemini API on every deploy (`npm run models:sync`).
- **Regenerate discussion** has the same Advanced overrides for a single
  regeneration.
- The preview site offers the same model list and thinking levels under
  Advanced Settings.

### Changed

- The bot now uses `gemini-flash-latest` (Google's newest Flash model) by
  default and lets the model decide how much to think, unless a mod sets an
  override.
- The `geminiModel` installation setting is removed. Installs that had set it
  switch to the new default; pick a model under **Configure bot → Advanced**
  to keep a specific one.
- Upgraded Devvit to 0.14.8.
- Messages no longer tell mods to "check logs", which they can't see. Toasts
  say what to expect (the post or comment appears within 30 seconds,
  otherwise a message arrives), and a manual "Check for new videos" now
  always ends in a new post or a PM: nothing new, a post awaiting approval,
  missing settings, or the failure. Failure PMs for Publish go to the mod who
  pressed it, and regeneration failures (missing key, deleted video) are now
  PM'd.
- Messages point to the subreddit's "…" menu, where the bot's menu items
  live, not "Mod Tools". Shorter mod menu descriptions.

### Fixed

- Video checks failed with "Thinking level MINIMAL is not supported for this
  model" on models that don't accept minimal thinking (e.g. Gemini 3 Pro).
  The bot no longer sends a thinking level unless a mod picks one the model
  accepts, and retries at the model's default if a model stops accepting it.

## [0.2.0] - 2026-10-11

### Added

- "Reject" action for a pending post: throws it away and records the video
  as `rejected` so it is never posted.
- "Regenerate discussion" on the post menu of any episode post (not just the
  latest). The form pre-fills the system prompt; edits apply to that one
  regeneration only. Posts created before discussion comments existed
  cannot be regenerated.

### Changed

- Episode submissions are now **link posts** pointing directly at the video
  instead of self posts, restoring Reddit's native thumbnail/preview card.
  The generated discussion body is posted separately as a distinguished,
  stickied top comment, since Reddit's post model cannot carry both a `url`
  and a text body on the same post. The `videoLinkLabel` setting is removed
  — it existed only to embed a markdown video link into the old self-post
  body, which is no longer needed now that the video itself is the post.
- Mod menu reduced from nine items to three subreddit items plus one post
  item:
  - "Configure bot" replaces "Set Google API Key" and "Set pin slot". Leave
    the key blank to keep the saved one.
  - "Review pending post" replaces "Post pending episode", "Edit & Post
    pending episode", and "Cancel pending episode": one form to edit, then
    Publish, Discard, or Reject. Discard throws the post away and the video
    is treated as unseen on the next check.
  - "Regenerate latest post" is now "Regenerate discussion" on the post menu.
  - "Force post latest video (testing)" is removed from the menu. On
    playtest (pre-release) installs only, "Check for new videos" opens a form
    with a force-repost option; elsewhere it runs immediately.
- The `last_episode_guid`, `last_episode_post_id`, `last_episode_comment_id`,
  `force_repost`, and `regenerate_triggered_by` Redis keys are no longer
  written.

### Fixed

- The 30-minute video check could be missing entirely: AppInstall/AppUpgrade
  did not reliably schedule it, leaving the bot to post only on manual checks
  with nothing in the logs. The app now resets the job on install/upgrade and
  re-verifies it (recreating it if missing) on any mod menu action and on new
  posts or comments in the subreddit, at most once per 30 minutes.
- With a long system prompt and a thinking model (e.g. `gemini-flash-latest`),
  Gemini could take longer than Devvit's 30-second HTTP limit and the run
  vanished with no log or notification. Requests now ask for minimal thinking
  effort and give up after 20 seconds with a logged error and a failure PM.
- A posted video that later went private and then public again was posted a
  second time. Posted videos now keep their registry record permanently.
- While a post waited for mod approval, every 30-minute check called Gemini
  again for the same video, and a newer video arriving meanwhile marked the
  pending video as `skipped`. Pending videos are now recorded as `pending`,
  and no generation happens while a post is pending.
- The video checker now reads the registry in one request instead of one
  Redis round trip per playlist video, and reads all installation settings
  concurrently instead of sequentially. Both scaled linearly with playlist
  size and were eating into Devvit's per-invocation execution budget on
  subreddits with a large video history.

## [0.1.9] - 2026-09-29

### Added

- Preview-site model selection now uses Gemini's live model list with
  relative speed and cost tiers, a recommended option, and fallback handling
  for retired models.
- Preview-site accessibility improvements include visible focus states,
  reduced-motion support, semantic status and error regions, and accessible
  control labels.

### Changed

- Episode submissions are now self posts containing the generated discussion
  body and a direct YouTube link. A blank video-link label defaults to
  `Watch on YouTube`.
- Updated Devvit packages to 0.14.6 and preview-site dependencies to their
  current releases.

### Fixed

- Regenerated posts and legacy queued posts retain a direct YouTube link.


## [0.1.8] - 2026-05-01

### Added

- "Set pin slot" mod menu item lets moderators choose sticky slot
  1 or 2 via a form. The selected slot is persisted in Redis under
  `last_episode_sticky_slot` and used on every subsequent pin.
- `build` script (`tsc -p src/tsconfig.json`) for one-shot
  TypeScript compilation.
- `watch` script (`tsc -p src/tsconfig.json --watch`) to
  recompile JS files automatically on save, keeping the compiled
  output in sync with the TypeScript source during development.

### Fixed

- `managePins` no longer calls `unsticky()` on the previously-tracked
  post before pinning the new one. It now calls `sticky(slot)` which
  atomically displaces the current occupant of that slot — preventing
  a double-unpin that could silently remove a mod-pinned post
  unrelated to the bot.

### Changed

- Pinned `@devvit/public-api`, `@devvit/web`, and `devvit` to
  `0.12.22` (exact versions, no caret).

### Changed

- Updated `@devvit/public-api`, `@devvit/web`, and `devvit` to
  `^0.12.20`.

## [0.1.6] - 2026-04-20

### Fixed

- `devvit publish` now runs with `--public` so the app is visible in
  the App Directory. Previous releases were published without this flag,
  hiding the app from public discovery.
- `tsconfig.json` now excludes `dist/`, `webroot/`, and disables
  `allowJs`/`checkJs` to prevent devvit build artifacts from being
  picked up as TypeScript inputs, fixing `TS5055` errors on
  `npm run type-check`.

## [0.1.5] - 2026-04-18

### Changed

- Updated `@devvit/public-api`, `@devvit/web`, and `devvit` to
  `^0.12.19`.

## [0.1.4] 2026-04-10

### Fixed

- Playlist fetch now paginates through all pages (50 items per page)
  rather than stopping at the first 50. Custom `PL…` playlists return
  items in insertion order, so newer episodes beyond position 50 were
  never seen by the bot.

### Changed

- All log lines in the `check_new_episodes` job now include the
  subreddit name in the prefix (e.g. `[bot:my_subreddit]`) so entries
  from different installs are easy to filter in `devvit logs`.

### Added

- Preview site: slow-generation warning banner appears after 25 seconds
  of generation, alerting users that Devvit enforces a 30-second HTTP
  timeout. Elapsed time is also shown on the result card when generation
  takes 25 seconds or more.

## [0.1.2] 2026-04-10

### Fixed

- Private videos that become public are now detected and posted rather
  than being permanently skipped. The bot now records private videos in
  the registry with a new `'private'` status. On each run, any video
  that transitions from `'private'` to public is treated as a new,
  unregistered video and queued for posting. A formerly-private video
  that goes public in the same run as a newer video keeps its
  `'private'` registry entry so it is picked up by the following run.

## [0.1.1] 2026-04-10

### Changed

- Updated `@devvit/public-api` and `devvit` to latest versions.

## [0.1.0] 2026-03-28

### Added

- Mod approval gate via `requireModApproval` to queue generated posts for
  moderator review before publishing.
- Auto-approve window via `autoApproveWindowMinutes` to publish queued posts
  after a configured delay, or hold indefinitely when set to `0`.
- New moderation actions: "Post pending episode", "Edit & Post pending
  episode", and "Cancel pending episode".
- Edit-before-post flow with a pre-populated form for pending title and body.
- `notificationMods` setting for comma-separated usernames to receive approval
  and failure notifications by PM.

### Fixed

- TypeScript config to remove missing `vitest/globals` reference and exclude
  `preview-site`, fixing `TS5055` output conflicts.
- `editPendingPostForm` callback `data` parameter type to match Devvit's
  `FormFunction` signature.

### Changed

- Updated `@devvit/public-api` and `devvit` to latest versions.
- "Force post latest video (testing)" now always routes through the approval
  queue to exercise the full moderation workflow.

[Unreleased]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.3.0...HEAD
[0.3.0]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.2.0...v0.3.0
[0.2.0]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.8...v0.2.0
[0.1.7]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.6...v0.1.7
[0.1.6]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.5...v0.1.6
[0.1.5]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.4...v0.1.5
[0.1.4]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.3...v0.1.4
[0.1.3]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.2...v0.1.3
[0.1.2]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.1...v0.1.2
[0.1.1]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.0...v0.1.1
[0.1.0]:
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/a55d564...v0.1.0
