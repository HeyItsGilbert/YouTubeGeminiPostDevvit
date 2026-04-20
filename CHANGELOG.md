# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.7] - 2026-04-20

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
  https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/compare/v0.1.7...HEAD
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
