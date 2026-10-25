# Blocks API → Devvit Web mapping (ticket #31)

Map: #28. Researched 2026-10-25 against `@devvit/web` 0.15.0 (npm latest) type
definitions, the published `devvit.json` schema, and developers.reddit.com docs.

Doc shorthand (all `https://developers.reddit.com/docs/capabilities/…`):
[config]: devvit-web/devvit_web_configuration.md ·
[menu]: client/menu-actions.md · [forms]: client/forms.md · [toasts]: client/toasts.md ·
[sched]: server/scheduler.md · [trig]: server/triggers.md ·
[settings]: server/settings-and-secrets.md · [redis]: server/redis.md ·
[http]: server/http-fetch.md · [reddit]: server/reddit-api.md ·
[schema]: https://developers.reddit.com/schema/config-file.v1.json

Types cited as `pkg/file` are from `node_modules/@devvit/*` installed by `npm i @devvit/web@0.15.0`.

## Status of Blocks

[config](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration.md):
"In Devvit 0.15, `blocks` and `@devvit/public-api` remain supported but deprecated." `devvit.json`
takes exactly one of `post` / `server` / `blocks`. A mod-tool app like this one uses `server`
(`{ "server": { "dir": "dist/server", "entry": "index.js" } }`) with no `post` entry.

## Inventory and mapping

Usage counted from `src/*.ts` (main.ts, postManager.ts, checkerSchedule.ts, videoRegistry.ts, episodeChecker.ts, llmClient.ts).

| Blocks usage in this app | Devvit Web equivalent | Gap / notes |
|---|---|---|
| `Devvit.configure({ redditAPI, redis, http })` (main.ts:12) | `devvit.json` `permissions` (`reddit`, `redis`, `http`) — already present in our devvit.json ([config](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration.md)) | None; delete the `configure` call. |
| `permissions.http.domains` youtube.googleapis.com, generativelanguage.googleapis.com; global `fetch` (episodeChecker.ts, llmClient.ts) | Same `permissions.http.domains`; plain `fetch` from server code ([http](https://developers.reddit.com/docs/capabilities/server/http-fetch.md)) | None. Allowlist unchanged. |
| `Devvit.addSettings([...])`, 12 settings, all `SettingScope.Installation`; types `string`, `paragraph`, `boolean`, `number` (main.ts:24-121) | `devvit.json` `settings.subreddit.<name>` ([settings](https://developers.reddit.com/docs/capabilities/server/settings-and-secrets.md)); read with `settings.get(name)` from `@devvit/web/server` | `paragraph` is **not** in the docs' "Setting types" list (string/boolean/number/select/multiSelect) but **is** in the schema (`ParagraphSetting` definition in [schema](https://developers.reddit.com/schema/config-file.v1.json)). Settings move from TS to JSON; validation now via optional `validationEndpoint`. |
| `context.settings.get` | `settings.get` (`@devvit/web/server`) ([settings](https://developers.reddit.com/docs/capabilities/server/settings-and-secrets.md)) | None. |
| `Devvit.addMenuItem({ location: 'subreddit', forUserType: 'moderator', onPress })` ×3 (Configure bot, Review pending post, Check now) | `devvit.json` `menu.items[]` `{ label, description, location: "subreddit", forUserType: "moderator", endpoint: "/internal/menu/…" }`; handler is an HTTP POST returning `UiResponse` ([menu](https://developers.reddit.com/docs/capabilities/client/menu-actions.md)) | `forUserType` defaults to `moderator` in Web. Label/description cannot be dynamic (same as Blocks). New: forms opened from a moderator menu action must be completed within **10 minutes** ([menu](https://developers.reddit.com/docs/capabilities/client/menu-actions.md)). |
| `Devvit.addMenuItem({ location: 'post', forUserType: 'moderator' })` (Regenerate discussion, main.ts:1156) reading `context.postId` | `menu.items[]` with `location: "post"`; request body `MenuItemRequest` has `targetId` (post id) ([sched](https://developers.reddit.com/docs/capabilities/server/scheduler.md) example: `const { targetId: postId } = await c.req.json<MenuItemRequest>()`); `context.postId` also exists on `BaseContext` (`shared-types/shared/baseContext.d.ts`) | None for the menu itself. |
| `Devvit.createForm(fn, onSubmit)` ×5 with dynamic fields/defaults built from `data` (configure bot, thinking level, review pending, playtest check, regenerate ×2); field types `string`, `paragraph`, `select`, `boolean`, `group` | `devvit.json` `forms: { "<name>": "/internal/form/<endpoint>" }`; server returns `UiResponse.showForm { name, form: { fields }, data }`; submit endpoint receives field values as JSON body ([forms](https://developers.reddit.com/docs/capabilities/client/forms.md), [config](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration.md)) | Form definition is built server-side per request, so dynamic options/defaults are natural (fields + `data`). `paragraph` and `group` shown in forms doc examples. See gap 1 on carrying `postId`. |
| `context.ui.showForm(form, data)` from a menu handler | Return `{ showForm: { name, form, data } }` ([menu](https://developers.reddit.com/docs/capabilities/client/menu-actions.md)) | None. |
| Opening a form from a form submit (configure bot → thinking level; regenerate → thinking level, main.ts:343, 1146) | Form submit endpoint returns another `showForm` — documented as "First form response leads to second form" ([menu](https://developers.reddit.com/docs/capabilities/client/menu-actions.md), "Multi-step forms" in [forms](https://developers.reddit.com/docs/capabilities/client/forms.md)) | Supported. Whole chain counts against the 10-minute moderator window. |
| `context.ui.showToast(msg)` (~17 sites) | Return `{ showToast: "…" }` in `UiResponse` ([toasts](https://developers.reddit.com/docs/capabilities/client/toasts.md), [menu](https://developers.reddit.com/docs/capabilities/client/menu-actions.md)) | One effect per response: code paths that toast *and then* open a form must choose one [INFERENCE from `UiResponse` shape]. Server endpoints cannot import `@devvit/web/client` ([menu](https://developers.reddit.com/docs/capabilities/client/menu-actions.md)). |
| `context.userId`, `context.reddit.getCurrentUser()` → `.username` (main.ts:484, 941, 1128, 1143) | `context.userId` / `context.username` on `BaseContext`; `reddit.getCurrentUser()` and `reddit.getCurrentUsername()` in `@devvit/reddit` `RedditClient.d.ts` | None; `context.username` saves a call. |
| `context.subredditName`, `context.appVersion` (checkerSchedule / main.ts) | Both on `BaseContext` (`shared-types/shared/baseContext.d.ts`) | None. |
| `Devvit.addSchedulerJob({ name, onRun })` ×3 (`check_new_episodes`, `post_pending_episode`, `regenerate_discussion`) | `devvit.json` `scheduler.tasks.<name>: { endpoint, cron? }`; handler is POST receiving `TaskRequest<T>` with `data` ([sched](https://developers.reddit.com/docs/capabilities/server/scheduler.md)) | **Every** job name, including one-offs, must be declared: "One-off tasks must also be declared in `devvit.json`" ([sched](https://developers.reddit.com/docs/capabilities/server/scheduler.md)). |
| `scheduler.runJob({ name, runAt, data })` (one-offs: post now, auto-approve timer, check now, regenerate) | `scheduler.runJob(ScheduledJobOptions)` (`scheduler/SchedulerClient.d.ts`) | None; `data` arrives as `TaskRequest.data`. |
| `scheduler.runJob({ name: 'check_new_episodes', cron })` + `listJobs` + `cancelJob` self-healing (checkerSchedule.ts) | Option A: declare `cron` in `devvit.json` `scheduler.tasks` (platform-managed). Option B (kept): `runJob({ name, cron, data })`, `listJobs([ScheduledActionManager.USER])`, `cancelJob(id)` (`SchedulerClient.d.ts`, [sched](https://developers.reddit.com/docs/capabilities/server/scheduler.md) "Create a recurring job at runtime") | Web's static cron removes the reason checkerSchedule.ts exists (its header says Blocks can't declare cron). `listJobs` now takes a `managers` filter; pass `USER` to see only app-created jobs. Covered in depth by the declared-cron ticket. |
| `Devvit.addTrigger({ events: ['AppInstall','AppUpgrade'] })` | `devvit.json` `triggers: { "onAppInstall": "/internal/…", "onAppUpgrade": "/internal/…" }` ([trig](https://developers.reddit.com/docs/capabilities/server/triggers.md), [config](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration.md)) | None; one endpoint per event key (may point both at the same path [INFERENCE]). |
| `Devvit.addTrigger({ events: ['PostSubmit','CommentSubmit'] })` (heal checker) | `triggers.onPostSubmit`, `triggers.onCommentSubmit` ([trig](https://developers.reddit.com/docs/capabilities/server/triggers.md)) | None. Likely removable if cron is declared statically [INFERENCE]. |
| Reddit: `submitPost`, `getPostById`, `post.sticky(slot)`, `getCommentById`, `comment.edit`, `comment.distinguish(true)`, `getAppUser`, `setUserFlair`, `getPostFlairTemplates`, `setPostFlair`, `sendPrivateMessage`, `getSubredditByName`, `modMail.createModInboxConversation` | `reddit` from `@devvit/web/server`; all methods present in `@devvit/reddit` `RedditClient.d.ts` / `models/Post.d.ts` (`sticky(position?: 1\|2\|3\|4)`) / `models/Comment.d.ts` (`edit`, `distinguish(makeSticky?)`) ([reddit](https://developers.reddit.com/docs/capabilities/server/reddit-api.md)) | None found; same `@devvit/reddit` client underlies both. |
| Redis `get` / `set` / `del` | `redis` from `@devvit/web/server` ([redis](https://developers.reddit.com/docs/capabilities/server/redis.md)) | None. |
| Redis `set(key, v, { expiration: Date })` (regenerate draft TTL, main.ts:1144) | Same option (`expiration?: Date` in `@devvit/redis` types); `expire`/`expireTime` also listed ([redis](https://developers.reddit.com/docs/capabilities/server/redis.md) "Key expiration") | None. |
| Redis hash `hGetAll`, `hGet`, `hSet`, `hDel` (videoRegistry.ts) | Same commands listed in [redis](https://developers.reddit.com/docs/capabilities/server/redis.md) hash table | None. Pipelining unsupported (also true today). |

## Real gaps

1. **`postId` through a form chain.** Blocks form `onSubmit` sees `context.postId`. In Web the
   submit body is the field values; `context.postId` is on `BaseContext`, but whether it is populated for a
   *form-submit* request launched from a post menu is not documented [INFERENCE: unverified]. Safe pattern:
   carry `postId` in the form's `data` (and/or a Redis draft keyed by `context.userId`, as the regenerate
   flow already does).
2. **Moderator form 10-minute limit** across menu → form → form chains ([menu](https://developers.reddit.com/docs/capabilities/client/menu-actions.md)). New constraint; affects only slow moderators.
3. **All scheduler job names must be declared in `devvit.json`** with an endpoint, including one-offs ([sched](https://developers.reddit.com/docs/capabilities/server/scheduler.md)).
4. **One UI effect per response** — `showToast` + `showForm` in the same handler can't both be imperatively fired as in Blocks [INFERENCE from `UiResponse`].
5. **`paragraph` setting type** is schema-valid but undocumented on the settings page — verify with `devvit upload` / playtest.
6. **Build/runtime shape change**: handlers become HTTP routes (Hono/Express examples in docs) under `/internal/*`; needs a server bundle (`server.dir`/`entry`). Not an API gap but the bulk of the work.

No Blocks API used by this app lacks a Web equivalent.
