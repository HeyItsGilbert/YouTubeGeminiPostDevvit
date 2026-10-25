# Does upgrading a live Blocks install to a Devvit Web version keep its state?

Research for [#32](https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues/32), part of the migration map [#28](https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues/28).
Sources were read on **2026-10-25**: the developers.reddit.com docs (Devvit 0.15.0), the `reddit/devvit` source at commit [`1cce4ce`](https://github.com/reddit/devvit/tree/1cce4cecf009511cc2395e89b45cebb230201baf), the npm packages installed in this repo (`@devvit/*` 0.14.8), `@devvit/build-pack` 0.15.0 from npm, and one developer report.
Anything not stated directly by a source is marked **[INFERENCE]**.

## Answer

**Yes for all four, as long as we upgrade the existing installation (same app name, `devvit install` / the App Directory **Update** button) and never uninstall and reinstall.** No Reddit doc names "Blocks to Web" as an upgrade case. The answer comes from three things:

1. The platform treats an upgrade as one installation moving to a new version. Data belongs to the installation, and only uninstalling deletes it.
2. In Devvit 0.14.8 and 0.15.0 a Devvit Web app is not a different kind of app. The CLI compiles `devvit.json` into the same `Devvit` singleton bundle that Blocks uses, with the same Redis, settings and scheduler plugins and the same trigger mechanism.
3. A developer has published a Blocks → Web upgrade of a live app ([badgebot-app](https://developers.reddit.com/apps/badgebot-app)) and reports that Redis data, settings and scheduled jobs survived it.

| Item | Survives? | Confidence | Condition |
|---|---|---|---|
| Redis data | **Yes** | High (docs + source + developer report) | Same app name, same installation, no uninstall. |
| Installation setting values | **Yes** | High for our setting types (source + developer report) | Each `devvit.json` `settings.subreddit` key must equal the old `Devvit.addSettings` `name`. Select settings have a value-format quirk, but this app has none. |
| Runtime-created scheduler jobs | **Yes, they persist** | High (docs + source) | They only *run* if `devvit.json` `scheduler.tasks` declares a task with the **same name**. A declared `cron` task does not cancel them, which risks a duplicate checker. |
| `onAppUpgrade` fires | **Yes** | High (docs + source + developer report) | Declare `triggers.onAppUpgrade` in `devvit.json`. The payload carries no from/to version. |

## Why one installation keeps its state across versions

- An upgrade is the same installation changing version. The trigger catalog defines `onAppUpgrade` as "A subreddit installation moving to a different version of the app", "produced when an installation changes version" ([Trigger Event Catalog → onAppUpgrade](https://developers.reddit.com/docs/capabilities/server/trigger-events#onappupgrade)).
- Storage belongs to the installation. "Each installation of an app has its own data storage." Only uninstalling loses it: "If you uninstall an app from a subreddit, your app history will be lost… you won't be able to retrieve the data or settings if you reinstall" ([Mod Resources → Data privacy](https://developers.reddit.com/docs/guides/best-practices/mod_resources)). The FAQ says the same ([FAQ → uninstall](https://developers.reddit.com/docs/guides/faq)). Redis: "Each installation of an app is uniquely name-spaced, which means Redis data is siloed by subreddit" ([Redis → Data storage](https://developers.reddit.com/docs/capabilities/server/redis)).
- Upgrading is a per-subreddit action. "Publishing a new version doesn't automatically update every subreddit. Use `devvit install` or … the blue **Update** button" ([FAQ → How do I update my app version?](https://developers.reddit.com/docs/guides/faq)). `devvit install r/sub [app]@version` can also move an install back to an older version ([Devvit CLI → devvit install](https://developers.reddit.com/docs/guides/tools/devvit_cli); [Playtest](https://developers.reddit.com/docs/guides/tools/playtest)).
- Reddit's docs treat partial and full Blocks → Web migration as ordinary versions of the same app. "Apps can be partially migrated… Once you've moved all public-api handlers, remove `blocks` and the legacy entry file" ([Migrating from Devvit Web Experimental](https://developers.reddit.com/docs/guides/migrate/devvit-web-experimental); [Migrating from useWebView](https://developers.reddit.com/docs/guides/migrate/inline-web-view); [Migrating devvit.yaml to devvit.json](https://developers.reddit.com/docs/guides/migrate/devvit-singleton)). None of these guides mentions any data step.

### A Devvit Web app is the same runtime underneath

This repo already builds through the `devvit.json` path (`"blocks": { "entry": "src/main.ts" }`). Its current bundle and a future server-only bundle are produced by the same code:

- `createDependencySpec` builds a bundle's plugin list from `devvit.json` alone, whether the app is Blocks or Web. `permissions.redis` → `RedisAPIDefinition`, `settings.subreddit` → `InstallationSettingsDefinition`, `triggers.onAppUpgrade` → `OnAppUpgradeDefinition`, `scheduler` → `SchedulerHandlerDefinition` ([dependency-spec-util.ts L158, L176–189, L219](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/dependency-spec-util.ts#L158-L219)). For a `blocks` app, the same config is filled with Blocks defaults: all triggers, settings and menu enabled ([config-file.v1.ts L448](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/shared-types/src/schemas/config-file.v1.ts#L448)).
- `blocks.template.ts` is the bundle entry for every `devvit.json` app. It imports `Devvit` from `@devvit/public-api` and turns each Web declaration into a classic call:
  - each trigger becomes `Devvit.addTrigger`, which POSTs to your endpoint ([L202](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts#L202));
  - each scheduler task becomes `Devvit.addSchedulerJob({ name })` ([L244–259](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts#L244-L259));
  - the settings become `Devvit.addSettings` ([L330–341](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts#L330-L341)).

  The same template ships unchanged in `@devvit/build-pack` **0.15.0** (checked from the npm tarball).
- Blocks and Web call the same client objects. Blocks' `context` clients come from the same packages that `@devvit/web/server` re-exports:
  - `@devvit/public-api` `makeAPIClients` imports `scheduler` from `@devvit/scheduler` and `settings` from `@devvit/settings` ([makeAPIClients.ts L1–9](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/public-api/src/apis/makeAPIClients.ts#L1-L9)).
  - `@devvit/web/server` re-exports `@devvit/redis`, `@devvit/scheduler` and `@devvit/settings` ([unpkg @devvit/web@0.14.8 server/index.js](https://unpkg.com/@devvit/web@0.14.8/server/index.js)).
  - Both runtimes' default `redis` is `RedisKeyScope.INSTALLATION` ([public-api RedisClient.ts L118](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/public-api/src/apis/redis/RedisClient.ts#L118); [redis/src/index.ts L11–12](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/redis/src/index.ts#L11-L12)).

**[INFERENCE]** The server can't tell a "Blocks version" from a "Web version" of an app. Both are bundles for the same app, using the same plugins against the same installation, so nothing is there to reset state.

### Developer report

The [badgebot-app](https://developers.reddit.com/apps/badgebot-app) listing says: "This version is the Devvit Web replacement for the original Blocks app. It keeps the original … existing Redis data, settings, flair behavior, moderator actions, and scheduled jobs." It also says: "Use the existing `badgebot-app` app identity when uploading this version. Do not create a second app if you want to retain installation data." It mentions that "It also accepts the legacy array representation of select-setting values, so current installation settings remain readable" and that "The upgrade trigger restores the saved posting schedule automatically." This is a third-party report, not Reddit documentation.

## 1. Redis data — survives

- The reasons are under [Why one installation keeps its state across versions](#why-one-installation-keeps-its-state-across-versions): an installation-scoped namespace, the same Redis client in both runtimes, and data deleted only on uninstall. Badgebot reports that its Redis keys survived.
- The Devvit Web overview recommends Redis exactly *because* it persists across versions: "Use Redis for data that needs to persist across app versions" ([Devvit Web overview](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview)).
- For us this covers `google_api_key`, `video_registry`, `pending_post`, `pending_post_job_id`, `last_episode_sticky_slot`, `gemini_model`, `gemini_thinking_level`, `episode_checker_*` and `check_triggered_by`. The Web code must keep the same key names and value formats (JSON shapes in `video_registry` and `pending_post`). Don't switch an existing key to `redisCompressed`: "Do not mix `redis` and `redisCompressed` on the same key" ([Redis](https://developers.reddit.com/docs/capabilities/server/redis)).

## 2. Installation setting values — survive

- Values are stored per installation, keyed by setting `name`, and read by name. `SettingsClient.getAll()` calls the settings plugin's `GetSettings` and returns `installationSettings.settings` keyed by name ([unpkg @devvit/settings@0.14.8 SettingsClient.js](https://unpkg.com/@devvit/settings@0.14.8/SettingsClient.js)). Blocks `context.settings` and Web `settings` are this same client (see above).
- Each `devvit.json` `settings.subreddit` key is copied into the setting's `name` ([config-file.v1.ts L675–701](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/shared-types/src/schemas/config-file.v1.ts#L675-L701)). The template then passes it to `Devvit.addSettings` with `SettingScope.Installation` ([blocks.template.ts L330–341](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts#L330-L341)). **[INFERENCE]** A Web setting with the same key (e.g. `youtubePlaylistId`) is the same installation setting, and its stored value carries over. Keys must match `^[a-zA-Z_][a-zA-Z0-9_-]*$` ([config schema](https://developers.reddit.com/schema/config-file.v1.json)); all 11 of our camelCase names do.
- Select settings are the one known quirk. The template converts a Web `select` default to the classic array form `[defaultValue]` ([blocks.template.ts](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts)), and badgebot had to accept "the legacy array representation of select-setting values". **Our settings are only `string`, `paragraph`, `boolean` and `number`** (`src/main.ts`; the selects there are form fields, not settings), so this does not apply.
- Our secret, the Google API key, lives in Redis, not in a setting, so the Redis answer covers it.

## 3. Runtime-created scheduler jobs — persist; they run only if their task names are declared

- Jobs persist. "Starting with Devvit 0.14.6, recurring jobs created in app code are preserved across deployments… `scheduler.runJob({ name, cron, data })` — The job keeps its stored schedule and data until your app cancels it." Also: "Keep task registrations and handlers available for jobs that survive upgrades" ([Scheduler → Managing recurring jobs across deployments](https://developers.reddit.com/docs/capabilities/server/scheduler)). That page doesn't separate Blocks and Web, and both use the same `@devvit/scheduler` client (see above).
- A job is delivered by name. A stored job carries `action.type = name`. When it fires, the runtime looks up `Devvit.scheduledJobHandlers.get(jobName)` and throws `Job ${jobName} not found` if nothing is registered ([public-api internals/scheduler.ts L17–20](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/public-api/src/devvit/internals/scheduler.ts#L17-L20)). In Web, handlers are registered only from `devvit.json` `scheduler.tasks` keys ([blocks.template.ts L244–259](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts#L244-L259)). **So the Web `devvit.json` must declare `check_new_episodes`, `post_pending_episode` and `regenerate_discussion` with exactly these names.** Task keys may be any string ([config schema](https://developers.reddit.com/schema/config-file.v1.json) `scheduler.tasks` `patternProperties: "^.+$"`).
  - The `check_new_episodes` cron is stored on every install.
  - A `post_pending_episode` one-off can be pending at upgrade time (an auto-approve timer, tracked by `pending_post_job_id`).
- A declared `cron` does not replace our runtime cron.
  - When any `devvit.json` task has `cron`, the template adds an `AppInstall`/`AppUpgrade` trigger. It lists jobs with managers `DEVVIT_JSON` and `MANAGER_UNSPECIFIED` only, cancels the cron ones, and reschedules the declared tasks under `DEVVIT_JSON` ([blocks.template.ts L269–304](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts#L269-L304)).
  - In 0.14.x, Blocks `context.scheduler.runJob` creates jobs with `manager: ScheduledActionManager.USER` ([unpkg @devvit/scheduler@0.14.8 SchedulerClient.js](https://unpkg.com/@devvit/scheduler@0.14.8/SchedulerClient.js), `runJob`).
  - **[INFERENCE]** The installed Blocks app's `check_new_episodes` cron (USER) survives an upgrade to a version that declares `check_new_episodes` with `cron`. Both would then run, giving two checkers.
  - The Web `onAppUpgrade` handler must cancel the legacy USER cron. `ensureCheckerScheduled` already lists jobs with no manager filter, which "returns jobs from all managers" (same Scheduler page). If it keeps creating the checker with `runJob`, nothing changes.
  - Jobs created before 0.14.x may be `MANAGER_UNSPECIFIED` **[INFERENCE]** from the template comment "legacy actions without a specified manager". The app's `ensureCheckerScheduled('reset')` re-creates the checker on every upgrade, so after any 0.14.x upgrade it should be USER.
- Removing the last declared cron later does not cancel it: "In Devvit 0.14.8, removing the final `cron` task from `devvit.json` does not automatically cancel the previously configured jobs" ([Scheduler](https://developers.reddit.com/docs/capabilities/server/scheduler)).
- Don't migrate by uninstalling and reinstalling. Besides losing data, an open platform bug says reinstalling leaves "ghost" schedules that `listJobs()` can't see or cancel ([reddit/devvit#239](https://github.com/reddit/devvit/issues/239)).

## 4. `onAppUpgrade` — fires

- It is a lifecycle event for "an installation changes version. Uploading or publishing a version does not by itself invoke every installation" ([Trigger Event Catalog → onAppUpgrade](https://developers.reddit.com/docs/capabilities/server/trigger-events#onappupgrade)). The Blocks → Web change is a version change of the same installation, so it qualifies **[INFERENCE]**. Badgebot reports its upgrade trigger restored the schedule on the Blocks → Web upgrade.
- What fires is the *new* version's handler. Declaring `"triggers": { "onAppUpgrade": "/internal/on-app-upgrade" }` adds `OnAppUpgradeDefinition` to the bundle ([dependency-spec-util.ts L189](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/dependency-spec-util.ts#L189)), and the template's `Devvit.addTrigger` forwards the event to that endpoint ([blocks.template.ts L202](https://github.com/reddit/devvit/blob/1cce4cecf009511cc2395e89b45cebb230201baf/packages/build-pack/src/esbuild/templatizer/blocks.template.ts#L202)). Endpoint and request type: [Triggers](https://developers.reddit.com/docs/capabilities/server/triggers) (`OnAppUpgradeRequest`).
- Caveats from the catalog:
  - "Make migrations idempotent and track your own schema or migration version. The payload does not contain the previous and new app version numbers." The handler can't detect "coming from Blocks" from the event; a Redis marker (e.g. `schema_version`) would have to do that.
  - `installer` is optional, and install events "can be delivered more than once".
- If the Web version also declares a `cron` task, the template's own `AppUpgrade` trigger runs too. **[INFERENCE]** Nothing documents the order between it and the app's handler, so neither may depend on the other.

## What a playtest-sub experiment must verify

Docs and source can't confirm the exact upgrade path for our app. Run this on a test subreddit; it is reversible because `devvit install r/<sub> @<blocks-version>` moves the install back.

1. **Baseline on the current Blocks version** (installed with `devvit install`, not only `playtest`, so the install has a normal version):
   - set every installation setting to a non-default value;
   - run "Configure bot" (API key, pin slot, model, thinking level);
   - leave a pending post with `autoApproveWindowMinutes > 0`, so a `post_pending_episode` one-off is queued;
   - record `listJobs()` (ids, names, cron/runAt);
   - read `video_registry` (`hLen`) and every Redis key from AGENTS.md.
2. **Upgrade the same installation** to a Web build with the same `name` in `devvit.json`, using `devvit upload` then `devvit install r/<sub>` (and/or a `playtest` session). Do not uninstall.
3. **Verify after the upgrade:**
   - (a) the `onAppUpgrade` endpoint logs once, maybe more (`devvit logs`), and records a marker in Redis;
   - (b) every setting value reads back unchanged through Web `settings.get()`, the number and boolean types included;
   - (c) all Redis keys and `hLen(video_registry)` match the baseline;
   - (d) `listJobs()` lists the old job ids. The legacy `check_new_episodes` cron fires into the Web task endpoint at its next `*/30` tick, and the queued `post_pending_episode` fires at its `runAt`;
   - (e) exactly one checker cron exists after the upgrade handler runs. Test this both with the runtime `runJob` approach and, if adopted, with a `devvit.json`-declared cron, to confirm the duplicate-cron risk in item 3;
   - (f) the version string has a fourth segment on playtest installs, so `isPlaytestInstall` still detects them;
   - (g) moving back to the Blocks version with `devvit install r/<sub> @<old>` keeps state as well (the rollback path).
4. **Negative control (optional):** confirm that a declared task name differing from the stored job name produces `Job … not found` errors. That proves the name-matching requirement.

## Sources not found / gaps

- No Reddit doc or changelog entry names "upgrading an installed Blocks app to a Devvit Web version" as a case. The [changelog](https://developers.reddit.com/docs/changelog) only lists 0.15.0 and says `blocks` / `@devvit/public-api` remain "supported but deprecated". `reddit/devvit` issue searches ("upgrade", "AppUpgrade", "settings lost", "redis lost", "migrat", "blocks to web") found nothing about losing state ([#259](https://github.com/reddit/devvit/issues/259) is an unrelated scheduler bug; [#239](https://github.com/reddit/devvit/issues/239) is reinstall-only).
- The server-side settings store and the scheduler service are closed source. Survival of setting values and the manager of pre-0.14 jobs come from the client code and one developer report, not from the server implementation.
