# Hono + Vite + `@devvit/start` for the Devvit Web server, with a `src/server/` split

The Devvit Web migration uses **Hono**, bundled by **Vite** via the `@devvit/start` plugin, exactly as `reddit/devvit-template-mod-tool-devvit-web` — the official template closest to this app's shape (mod tool, no client/webview). Devvit Web server bundles must be CommonJS; the current `tsc -p src/tsconfig.json` build emits ESM, and `@devvit/start`'s plugin is the only demonstrated, maintained way to produce the required CJS bundle without hand-rolling one.

New Devvit-specific code goes under `src/server/`, split by this app's own features (`routes/configure-bot.ts`, `routes/check-episodes.ts`, `routes/pending-post.ts`, `routes/regenerate.ts`), each holding that feature's menu item, form(s), and scheduler job together — not split by Devvit primitive (`menu.ts`/`forms.ts`/`triggers.ts`) as the template does, since this app's surface (3 subreddit menu items, 1 post menu item, ~5 forms, 3 scheduler jobs, 2 triggers) would turn a primitive-split file into a grab-bag of unrelated features. `postUtils.ts`, `types.ts`, `geminiModels.ts`, and `geminiModels.generated.ts` stay at `src/` root, untouched, so the preview site's `@shared` → `../src` Vite/TS alias needs no change.

## Considered Options

- **Express or plain Node `http` handlers, hand-bundled with esbuild/tsup**: no Devvit Web template demonstrates this; we'd own the CJS-bundling problem Vite's plugin already solves, for no capability gain — this app has no requirement the official stack can't meet.
- **Move every shared module under `src/server/` and repoint `@shared` to `../src/server`**: forces an edit to the preview site's alias and tsconfig/vite config for a purely cosmetic move; rejected in favor of leaving the already-platform-agnostic files where they are.
- **Mirror the template's `routes/{menu,forms,triggers}.ts` split**: fits the template's 2-feature scope; doesn't fit this app's larger, more varied surface.

## Consequences

- `package.json`'s build/dev scripts move from `tsc -p src/tsconfig.json` to `vite build` (and `vite build --watch` for `dev`), per the template's `devvit.json` `scripts` block.
- The template pins `"engines": { "node": ">=24.0.0" }`; carry that forward if the migration adopts the template's `package.json` wholesale.
- The `src/` vs `src/server/` boundary becomes the enforced line between platform-agnostic logic (importable by the preview site) and Devvit-specific code (Reddit/Redis/fetch, routes) — the distinction AGENTS.md already documents in prose.
