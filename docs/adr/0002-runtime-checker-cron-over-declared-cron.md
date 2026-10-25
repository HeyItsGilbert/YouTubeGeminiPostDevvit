# Runtime checker cron over a declared cron

The recurring `check_new_episodes` cron stays a runtime `USER` job kept alive by `ensureCheckerScheduled` (reset on install/upgrade, throttled heal on mod actions and subreddit activity), even on Devvit Web where `devvit.json` `scheduler.tasks` can declare crons. A declared cron is created only by the build-injected `AppInstall`/`AppUpgrade` handlers, the same triggers observed not firing on a playtest install across six version changes, and app code can't recreate a `DEVVIT_JSON` job, so a declared cron gives up the heal that repairs that failure. `check_new_episodes` is declared in `scheduler.tasks` without a `cron` so its endpoint is routable, and `ensureCheckerScheduled` lists only `USER` jobs.

## Considered Options

- **Declared cron only**: drops `checkerSchedule.ts`, but an install whose triggers don't fire never checks for videos, with no recovery.
- **Declared cron plus a `USER` fallback heal**: two mechanisms that can each create a checker; every upgrade recreates the declared cron beside the fallback. `check_new_episodes` has no run lock, so two checkers can post the same Video twice.

## Consequences

- The Blocks-era `USER` checker carries over unchanged on upgrade: no cleanup step and no migration marker are needed.
- `ensureCheckerScheduled` MUST filter `listJobs` to `ScheduledActionManager.USER`; an unfiltered list would also match any declared cron.
- Revisit a declared cron only as its own change, after trigger reliability on Devvit Web has been observed.
