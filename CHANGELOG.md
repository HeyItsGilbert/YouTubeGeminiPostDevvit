# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Mod approval gate: new `requireModApproval` setting holds generated posts for mod review instead of posting immediately. Mods publish via "Post pending episode", "Edit & Post pending episode", or discard with "Cancel pending episode" menu items.
- Auto-approve window: new `autoApproveWindowMinutes` setting auto-publishes queued posts after a configurable delay if no mod acts first. Set to 0 for indefinite hold.
- Edit before posting: "Edit & Post pending episode" opens a form pre-populated with the generated title and body so mods can tweak content before publishing.
- Notification recipients: new `notificationMods` setting sends approval notifications to specific mod usernames via PM. Falls back to general mod inbox when blank.
- Failure notifications routed through `notificationMods` first, falling back to the mod who triggered the action.
- "Force post latest video (testing)" now always queues via the mod approval flow so mods can test the full approval pipeline.

### Fixed

- TypeScript config: overrode `types` to remove missing `vitest/globals` reference and excluded `preview-site` to fix `TS5055` output file conflict.
- `editPendingPostForm` callback `data` parameter type to match Devvit's `FormFunction` signature.

### Changed

- Updated `@devvit/public-api` and `devvit` to latest versions.
