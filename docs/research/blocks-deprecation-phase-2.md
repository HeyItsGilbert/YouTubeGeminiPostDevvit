# What Devvit Blocks deprecation Phase 2 changes, and when

Research for ticket [#30](https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues/30) (part of map [#28](https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues/28)).
Sources were checked on **2026-10-25**. Anything not stated directly in a source is marked **[INFERENCE]**.

## Answer

Phase 2 ("No More Blocks Configuration") took effect with **Devvit 0.15.0 on Monday 2026-10-19**. It enforces exactly one thing: **`devvit.yaml` is no longer supported**, so apps must move to `devvit.json` before they upgrade to 0.15.0. It does **not** remove the `blocks` property of `devvit.json` or `@devvit/public-api`. Both are "supported but deprecated", and the Devvit team says there are **no current plans to remove them**. Apps that stay on an older Devvit version "will not be disrupted". No Phase 3 has been announced and no date exists for one.

**For this app:** we already use `devvit.json` (`blocks.entry: src/main.ts`), have no `devvit.yaml`, and never call `addCustomPostType`. **Neither phase forces a change**, and we can upgrade to 0.15.0 while keeping `blocks`. Migrating to Devvit Web is recommended, but no deadline forces it yet.

## How the announcement was read

`www.reddit.com` returns HTTP 403 for `.json` and the HTML page. Two routes worked:

- Reddit's own **RSS feed for the thread**, `https://www.reddit.com/r/Devvit/comments/1x4xpap/.rss`, returned HTTP 200 with the post and all 15 comments, including author names and timestamps. This is a first-party source. Later RSS calls were rate-limited (HTTP 429) for a short time.
- The Redlib mirror `https://sandbag.ddns.net/r/Devvit` (subreddit listing and search) shows full post bodies. Its per-thread pages fail with "Failed to parse page JSON data".

## Enforcement timeline

| # | Date | What is enforced | Source |
|---|---|---|---|
| 0 | 2026-02-13 (announced) | Blocks renderer for interactive posts to be deprecated. Developers who actively maintain Blocks apps have until **2026-06-30**. Mod tools "that use only menu items and forms on the front-end should not be impacted". | [Devvit Web and the future of Devvit](https://www.reddit.com/r/Devvit/comments/1r3xcm2/devvit_web_and_the_future_of_devvit/) (u/sir_axolotl_alot, admin) |
| 1a | Devvit 0.12.13 (released 2026-02-17) | `Devvit.addCustomPostType` "will be marked as deprecated". The [0.12.13 changelog entry](https://developers.reddit.com/docs/0.12/changelog#devvit-01213-minor-tweaks) does not mention it, so the deprecation marker could not be confirmed. | Same post; [npm publish time](https://registry.npmjs.org/@devvit%2fpublic-api) 2026-02-17T19:40Z |
| 1b | **2026-03-01** | "New apps with custom posts that use `Devvit.addCustomPostType` will be rejected during App Review. This will not affect existing apps." | [1r3xcm2](https://www.reddit.com/r/Devvit/comments/1r3xcm2/devvit_web_and_the_future_of_devvit/) |
| 1c | 2026-04-10 | Clarification: an app is impacted **only if it uses `addCustomPostType()`**. Developers who have `blocks` in `devvit.json` but no `addCustomPostType()` were notified in error and can ignore that notice. | [Upcoming Deprecation of apps that use Blocks Renderer](https://www.reddit.com/r/Devvit/comments/1shophd/upcoming_deprecation_of_apps_that_use_blocks/) (admin) |
| 1d | Devvit 0.13.0 (released **2026-05-26**) | The SDK removes all custom-post features from the Devvit singleton: `addCustomPostType()`, `submit()` of custom posts, `setPostData()`, `setCustomPostPreview()`, `usePayments()`, `realtime`/`useChannel`, `Devvit.Context` and `kvStore`. "Menu actions and forms remain intact … (But this is deprecated, and support will be dropped in the future!)". The upgrade itself is optional. | [0.13.0 changelog](https://developers.reddit.com/docs/0.13/changelog#release-0130-logged-out-users-push-notifications-app-telemetry-and-more); [0.13.0 announcement](https://www.reddit.com/r/Devvit/comments/1tpdoko/devvit_0130_removing_blocks_adding_push/) |
| 1e | **2026-06-30** ("Completed June 30th") | **Phase 1, No More Blocks Rendering.** Blocks UI support is removed from all clients (web, Android, iOS). Apps with Blocks custom posts are "disabled from the Devvit runtime and users won't be able to interact with them anymore". Afterwards the platform is "rejecting all new or updated apps using addCustomPostType for post rendering". | [0.13.0 changelog note](https://developers.reddit.com/docs/0.13/changelog#release-0130-logged-out-users-push-notifications-app-telemetry-and-more); [1r3xcm2](https://www.reddit.com/r/Devvit/comments/1r3xcm2/devvit_web_and_the_future_of_devvit/); [Phase 2 post](https://www.reddit.com/r/Devvit/comments/1x4xpap/devvit_blocks_deprecation_phase_2/) |
| 2a | 2026-10-13 (announced) | Phase 2 announced: "We'll be completing the deprecation of Blocks in the Devvit 0.15.0 release by removing remaining blocks-based app configs." | [Devvit Blocks Deprecation – Phase 2](https://www.reddit.com/r/Devvit/comments/1x4xpap/devvit_blocks_deprecation_phase_2/) (u/RedditParadox, posted 2026-10-13T14:11Z per RSS) |
| 2b | **Monday 2026-10-19** (0.15.0; npm publish 2026-10-19T22:33Z) | **Phase 2, No More Blocks Configuration.** "All apps using devvit.yaml need to fully move to devvit.json." 0.15.0 changelog: "Devvit no longer supports `devvit.yaml`. Migrate to `devvit.json` before upgrading to 0.15.0." Also in 0.15.0, and unrelated to Blocks: the `reddit.getWikiPage(subredditName, page, revisionId)` signature is removed. | [Phase 2 post](https://www.reddit.com/r/Devvit/comments/1x4xpap/devvit_blocks_deprecation_phase_2/); [0.15.0 changelog](https://developers.reddit.com/docs/changelog#release-0150-api-updates--expanded-mode-improvements); [npm](https://registry.npmjs.org/@devvit%2fpublic-api) |
| 2c | 2026-10-19 onward | **Not enforced:** the `blocks` property and `@devvit/public-api` "remain supported but deprecated". The JSON Schema marks `blocks` as `"deprecated": true`, but the property is still valid and `devvit.json` must contain at least one of `post`, `server` or `blocks`. | [0.15.0 changelog](https://developers.reddit.com/docs/changelog#release-0150-api-updates--expanded-mode-improvements); [Configure your app](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration); [config-file.v1.json](https://developers.reddit.com/schema/config-file.v1.json) |
| 2d | 2026-10-19 onward | **Existing installs and apps that don't upgrade:** "Apps that do not upgrade to the new version of Devvit will not be disrupted due to these changes. However, anyone who has not migrated their apps to Devvit Web should do so to continue development of their app." | [Phase 2 post](https://www.reddit.com/r/Devvit/comments/1x4xpap/devvit_blocks_deprecation_phase_2/) |
| 3 | **None announced** | A developer asked whether a Phase 3 will remove the `blocks` property or the singleton pattern. Admin reply: "devvit/public-api is still supported but deprecated. **No current plans for removal** of it or the devvit.json blocks property. The recommended guidance is still to move to devvit/web." | [Admin comment pghu77h](https://www.reddit.com/r/Devvit/comments/1x4xpap/devvit_blocks_deprecation_phase_2/pghu77h/) (u/RedditParadox, 2026-10-13T15:09Z) |

Other first-party statements:

- The migration guides all repeat the same line: "In Devvit 0.15, `blocks` and `@devvit/public-api` remain supported but deprecated." Pages: [devvit-singleton](https://developers.reddit.com/docs/guides/migrate/devvit-singleton), [devvit-web-experimental](https://developers.reddit.com/docs/guides/migrate/devvit-web-experimental) and [inline-web-view](https://developers.reddit.com/docs/guides/migrate/inline-web-view). They also say apps "can be partially migrated", meaning `blocks.entry` and a `server` entry can coexist.
- The singleton guide still tells developers to run `devvit playtest` after upgrading to 0.15 with `blocks`. So playtest of `blocks` apps on 0.15 is documented as working: [devvit-singleton § Test your app](https://developers.reddit.com/docs/guides/migrate/devvit-singleton).
- The [FAQ](https://developers.reddit.com/docs/guides/faq) entry "I got a notice that Blocks is deprecated" lists `devvit.yaml`, `addCustomPostType()`, `submitCustomPost()` with `preview` and `useWebView` as the things to fix. Using `blocks.entry` for menu actions and triggers alone is not on that list.
- Abandoned apps: "We don't currently have a program for adopting abandoned apps." See [comment pghx1jy](https://www.reddit.com/r/Devvit/comments/1x4xpap/devvit_blocks_deprecation_phase_2/pghx1jy/).

## The specific questions on the ticket

| Question | Phase 1 (2026-06-30) | Phase 2 (2026-10-19) |
|---|---|---|
| New uploads blocked? | New apps using `addCustomPostType` were rejected at App Review from 2026-03-01, and "new or updated" ones after Phase 1. | 0.15.0 CLI/SDK drops `devvit.yaml`. Nothing first-party says uploads with `blocks` in `devvit.json` are blocked. |
| Publishing blocked? | Yes for `addCustomPostType` apps (App Review rejection). | No statement that `blocks`-only apps are rejected at review. **Not confirmed either way** for brand-new `blocks` submissions. |
| Playtest disabled? | Not stated. Blocks custom posts can't render on any client, so playtesting them is moot. [INFERENCE] | No. The 0.15 migration guide tells `blocks` apps to playtest. |
| Existing installs stop running? | Yes, for apps with Blocks custom posts (runtime-disabled). Menu/form/trigger-only mod tools were explicitly exempt. | No: "Apps that do not upgrade … will not be disrupted." |
| Later phases? | n/a | None announced. Admin: "No current plans for removal" of `blocks` or `@devvit/public-api`. |

## Impact on YouTubeGeminiPostDevvit

- `devvit.json` already exists and has `blocks.entry: src/main.ts`. The repo has no `devvit.yaml`, and `src/` contains no `addCustomPostType`, `useWebView` or `submitCustomPost` (checked with grep on 2026-10-25). The app pins `@devvit/public-api` / `@devvit/web` / `devvit` at **0.14.8**.
- **Phase 1 did not affect us.** We are a menu/form/trigger mod tool, the exempt category.
- **Phase 2 does not block us.** We can stay on 0.14.8 ("will not be disrupted") or upgrade to 0.15.0 without migrating, because `blocks` stays valid in 0.15. The only 0.15.0 breaking changes are `devvit.yaml` (we don't use it) and the 3-argument `getWikiPage` (`src/` has no `wiki` or `getWikiPage` references, checked with grep on 2026-10-25).
- **Urgency: low, but there is a documented direction.** Reddit calls `blocks` and public-api deprecated, says "support will be dropped in the future" (0.13.0 changelog), and says non-migrated apps "should do so to continue development". [INFERENCE] Reddit's past notice periods were about 4.5 months for a disruptive change (Phase 1: announced 2026-02-13, enforced 2026-06-30) and 6 days for a non-disruptive one (Phase 2: announced 2026-10-13, enforced 2026-10-19). A future removal of `blocks` is disruptive for us, so we would probably get months of notice, but no source promises that.

## Could not be confirmed

- Whether **older CLI versions (≤0.14.x)** can still upload or publish **new versions** after 2026-10-19. The only first-party statement is "will not be disrupted", which is about running apps. Nothing says Reddit enforces a minimum CLI or SDK version on upload.
- Whether **App Review rejects brand-new submissions** that use `blocks` without `addCustomPostType`. No source says it does. The admin's "no current plans for removal" suggests not. [INFERENCE]
- Whether the 0.12.13 SDK actually added a `@deprecated` marker to `addCustomPostType`. The announcement says so, but the [0.12.13 changelog](https://developers.reddit.com/docs/0.12/changelog#devvit-01213-minor-tweaks) is silent, and our installed 0.14.8 no longer has the API, so it could not be checked.
- Any **Phase 3** date or scope. None exists in the docs, the changelog (latest is 0.15.0, 2026-10-19; npm `next` is `0.15.1-next-2026-10-23`) or the thread.
- Discord announcements weren't checked (no unauthenticated access).
