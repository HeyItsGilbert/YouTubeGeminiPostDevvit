# YouTube + Gemini Auto-Post Bot — Migration & Implementation Plan

## Goal

Migrate from the `hellocrawlers`-specific Devvit app to a **generic, reusable** "YouTube + Gemini" bot that any subreddit can install and configure. Mods supply their own YouTube playlist, Gemini API key, system prompt, flair, and model preference. The YouTube Data API and Gemini API are both free-tier, making this a zero-cost automation for any community.

---

## What Changes vs. What Stays

| Aspect | Current (hellocrawlers) | Target (generic) |
|--------|------------------------|-------------------|
| App name | `hellocrawlers` | `youtube-gemini-post` |
| YouTube playlist ID | Hardcoded constant | **Installation setting** (mod-supplied) |
| Google API key | App-level secret (developer-owned) | **Installation setting** (mod-supplied, secret) |
| Gemini model | Hardcoded `gemini-2.0-flash` | **Installation setting** with default |
| System prompt | Hardcoded DCC voice in `systemPrompt.ts` | **Installation setting** (mod-supplied text) |
| Flair name | Hardcoded `Episode Discussion` | **Installation setting** (mod-supplied, optional) |
| Target subreddit | Setting with default `hellocrawlers` | **Derived from context** (`context.subredditName`) |
| Post title prefix | Hardcoded `[Episode Discussion]` | Controlled by the mod's prompt (no app-level prefix) |
| Scheduler job | Unchanged | Unchanged |
| Pin management | Unchanged | Unchanged |
| Mop (nuke) tool | Unchanged | Unchanged |
| YouTube API integration | Unchanged (parameterized) | Unchanged (parameterized) |
| Gemini API integration | Unchanged (parameterized) | Unchanged (parameterized) |

---

## Architecture (post-migration)

```
src/
  main.ts              ← Entry point: settings, scheduler, triggers, menu actions
  episodeChecker.ts    ← YouTube Data API: fetch latest video from a playlist
  claudeClient.ts      ← Gemini API: generate post content with user-supplied prompt
  postManager.ts       ← Reddit: post creation, flair assignment, pin rotation
  systemPrompt.ts      ← REMOVED (prompt now comes from settings)
  types.ts             ← Shared types (unchanged)
  nuke.ts              ← Mod tool (unchanged)
```

---

## Phase 0 — Rebrand & Rename

### 0.1 `devvit.yaml`

```yaml
name: youtube-gemini-post
```

### 0.2 `package.json`

Change `"name"` from `"hellocrawlers"` to `"youtube-gemini-post"`.

### 0.3 Purge hellocrawlers references

Remove or genericize every remaining `hellocrawlers` reference:

| File | What to change |
|------|---------------|
| `src/types.ts` | Update doc comment ("Hello Crawlers episode bot" → "YouTube + Gemini auto-post bot") |
| `src/main.ts` | Remove default `'hellocrawlers'` from subreddit setting; update menu item descriptions |
| `src/postManager.ts` | Remove hardcoded `'episode discussion'` string; accept flair name as parameter |
| `src/claudeClient.ts` | Remove hardcoded model and `[Episode Discussion]` prefix; accept model and prompt as parameters |
| `src/episodeChecker.ts` | Remove hardcoded `PLAYLIST_ID`; accept playlist ID as parameter |
| `README.md` | Full rewrite for generic audience |
| `PRIVACY_POLICY.md` | Update app name and description |
| `TERMS_AND_CONDITIONS.md` | Update app name and description |

### 0.4 `SystemPrompt.md` → `SystemPrompt.example.md`

Rename and reframe as an **example prompt** that mods can copy and adapt. Add a header explaining its purpose:

```markdown
# Example System Prompt — Hello Crawlers (DCC Universe)

> This is a sample system prompt used by r/hellocrawlers. Copy and adapt it for
> your own community. Paste your finished prompt into the app's "System Prompt"
> setting.

(existing prompt content follows)
```

### 0.5 Delete `src/systemPrompt.ts`

The hardcoded prompt export is replaced by the installation setting. Remove the file and its import in `claudeClient.ts`.

---

## Phase 1 — Settings Overhaul

Replace the current two settings with a full mod-configurable set. All settings use `SettingScope.Installation` so each subreddit controls its own configuration.

### 1.1 New settings definition (in `main.ts`)

```typescript
Devvit.addSettings([
  // --- API Access ---
  {
    type: 'string',
    name: 'googleApiKey',
    label: 'Google API Key',
    helpText: 'Enables both YouTube Data API and Gemini. Free from Google Cloud Console.',
    isSecret: true,
    scope: SettingScope.Installation,
  },

  // --- YouTube Source ---
  {
    type: 'string',
    name: 'youtubePlaylistId',
    label: 'YouTube Playlist ID',
    helpText: 'The playlist to monitor for new videos (e.g., PL0WMaa8s_mXGb3089AMtiyvordHKAZKi9).',
    scope: SettingScope.Installation,
  },

  // --- Gemini Configuration ---
  {
    type: 'string',
    name: 'geminiModel',
    label: 'Gemini Model',
    helpText: 'Model ID for post generation. Default: gemini-2.0-flash (free tier).',
    defaultValue: 'gemini-2.0-flash',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'systemPrompt',
    label: 'System Prompt',
    helpText: 'Instructions for Gemini. Defines the voice, structure, and rules for generated posts. First line of output is used as the post title.',
    scope: SettingScope.Installation,
  },

  // --- Reddit Post Options ---
  {
    type: 'string',
    name: 'flairName',
    label: 'Post Flair (optional)',
    helpText: 'Exact name of a post flair template on this subreddit. Leave blank for no flair.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
]);
```

### 1.2 Settings removed

| Setting | Reason |
|---------|--------|
| `subredditName` | No longer needed — use `context.subredditName` at runtime |

### 1.3 Key change: API key scope

The Google API key moves from `SettingScope.App` (developer-owned, shared across all installs) to `SettingScope.Installation` (each mod supplies their own). This is critical for a generic app — we cannot share a single API key across unknown subreddits.

---

## Phase 2 — Parameterize Hardcoded Values

Each module currently uses top-level constants. These become function parameters sourced from settings.

### 2.1 `episodeChecker.ts`

**Before:**
```typescript
const PLAYLIST_ID = 'PL0WMaa8s_mXGb3089AMtiyvordHKAZKi9';

export async function fetchLatestYouTubeEpisode(apiKey: string): Promise<EpisodeData | null> {
  // uses PLAYLIST_ID
}
```

**After:**
```typescript
export async function fetchLatestYouTubeEpisode(
  apiKey: string,
  playlistId: string
): Promise<EpisodeData | null> {
  // uses playlistId parameter
}
```

Remove the `PLAYLIST_ID` constant entirely.

### 2.2 `claudeClient.ts`

**Before:**
```typescript
import { SYSTEM_PROMPT } from './systemPrompt.js';
const GEMINI_MODEL = 'gemini-2.0-flash';

export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData
): Promise<GeneratedPost> { ... }
```

**After:**
```typescript
// No import of systemPrompt.js

export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData,
  systemPrompt: string,
  geminiModel: string
): Promise<GeneratedPost> { ... }
```

Remove the `GEMINI_MODEL` constant and the `systemPrompt.js` import.

**Title parsing change:** The `parseGeneratedResponse` function currently enforces a `[Episode Discussion]` prefix. Since the mod's prompt controls the title format, remove this enforcement. Simply use the first non-empty line as the title and the rest as the body — no prefix injection.

### 2.3 `postManager.ts`

**Before:**
```typescript
export async function applyEpisodeFlair(
  reddit: RedditClient,
  subredditName: string,
  postId: string
): Promise<void> {
  // hardcoded match: 'episode discussion'
}
```

**After:**
```typescript
export async function applyFlair(
  reddit: RedditClient,
  subredditName: string,
  postId: string,
  flairName: string
): Promise<void> {
  if (!flairName) return; // no flair configured — skip silently

  const flairs = await reddit.getPostFlairTemplates(subredditName);
  const match = flairs.find(
    (f) => (f.text ?? '').toLowerCase().trim() === flairName.toLowerCase().trim()
  );
  // ...
}
```

Function renamed from `applyEpisodeFlair` to `applyFlair` to reflect its generic purpose.

---

## Phase 3 — Update Orchestration (`main.ts`)

### 3.1 Scheduler job — read settings and pass through

```typescript
Devvit.addSchedulerJob({
  name: 'check_new_episodes',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;

    try {
      // Read all settings
      const googleApiKey = await settings.get<string>('googleApiKey');
      const playlistId = await settings.get<string>('youtubePlaylistId');
      const geminiModel = (await settings.get<string>('geminiModel')) || 'gemini-2.0-flash';
      const systemPrompt = await settings.get<string>('systemPrompt');
      const flairName = (await settings.get<string>('flairName')) || '';

      // Validate required settings
      if (!googleApiKey || !playlistId || !systemPrompt) {
        console.error('[bot] Missing required settings (googleApiKey, youtubePlaylistId, or systemPrompt).');
        return;
      }

      // Use context.subredditName instead of a setting
      const subredditName = context.subredditName!;

      // Fetch → detect → generate → post → flair → pin (same flow, parameterized)
      const episode = await fetchLatestYouTubeEpisode(googleApiKey, playlistId);
      if (!episode) return;
      if (!(await isNewEpisode(redis, episode))) return;

      const { title, body } = await generateEpisodePost(googleApiKey, episode, systemPrompt, geminiModel);
      const post = await createEpisodePost(reddit, subredditName, title, body);

      if (flairName) {
        await applyFlair(reddit, subredditName, post.id, flairName);
      }

      await managePins(reddit, redis, post.id);
      await redis.set('last_episode_guid', episode.guid);
      await redis.set('last_episode_post_id', post.id);
    } catch (err) {
      console.error('[bot] Episode checker failed:', err);
    }
  },
});
```

### 3.2 Menu action — update description

```typescript
Devvit.addMenuItem({
  label: 'Check for new videos',
  description: 'Manually check the YouTube playlist for new videos and generate a post.',
  location: 'subreddit',
  forUserType: 'moderator',
  // ...
});
```

### 3.3 Log prefix

Change `[episodeBot]` → `[bot]` or `[yt-gemini]` throughout — no hello-crawlers branding.

---

## Phase 4 — Documentation

### 4.1 `README.md` — full rewrite

Target audience: a mod who has never seen this app before. Cover:

- What the app does (one paragraph)
- Setup steps: install → set Google API key → set playlist ID → write a system prompt → (optional) set flair and model
- How to get a free Google API key (link to Cloud Console, enable YouTube Data API v3 + Generative Language API)
- Settings reference table
- Commands table (`npm run dev`, etc.)
- Redis keys table
- Link to `SystemPrompt.example.md` as a starting template

### 4.2 `PRIVACY_POLICY.md` / `TERMS_AND_CONDITIONS.md`

Replace `hellocrawlers` references with the generic app name.

---

## Phase 5 — Cleanup

### 5.1 Delete compiled `.js` files from source control

The `src/` directory currently contains both `.ts` and `.js` files. Add `src/*.js` to `.gitignore` and remove the tracked `.js` files.

### 5.2 Delete `src/systemPrompt.ts` and `src/systemPrompt.js`

No longer needed — the prompt comes from settings.

### 5.3 `SystemPrompt.md` → `SystemPrompt.example.md`

Rename and add the example header (see Phase 0.4).

---

## Implementation Order

| # | Task | Files Touched | Depends On |
|---|------|---------------|------------|
| 1 | Rename app in `devvit.yaml` and `package.json` | `devvit.yaml`, `package.json` | — |
| 2 | Replace settings block in `main.ts` | `src/main.ts` | — |
| 3 | Parameterize `episodeChecker.ts` (accept `playlistId`) | `src/episodeChecker.ts` | — |
| 4 | Parameterize `claudeClient.ts` (accept `systemPrompt`, `geminiModel`; remove prefix logic) | `src/claudeClient.ts` | — |
| 5 | Parameterize `postManager.ts` (accept `flairName`; rename function) | `src/postManager.ts` | — |
| 6 | Update scheduler job and menu action in `main.ts` | `src/main.ts` | 2, 3, 4, 5 |
| 7 | Delete `src/systemPrompt.ts` + `.js` | `src/systemPrompt.ts`, `src/systemPrompt.js` | 4, 6 |
| 8 | Rename `SystemPrompt.md` → `SystemPrompt.example.md` | `SystemPrompt.md` | — |
| 9 | Remove tracked `.js` files; update `.gitignore` | `src/*.js`, `.gitignore` | — |
| 10 | Rewrite `README.md` | `README.md` | All above |
| 11 | Update `PRIVACY_POLICY.md`, `TERMS_AND_CONDITIONS.md` | Legal docs | 1 |
| 12 | Update `types.ts` doc comments | `src/types.ts` | — |

---

## Settings Reference (post-migration)

| Name | Type | Scope | Secret | Default | Purpose |
|------|------|-------|--------|---------|---------|
| `googleApiKey` | string | Installation | **Yes** | — | Google API key (YouTube + Gemini) |
| `youtubePlaylistId` | string | Installation | No | — | YouTube playlist to monitor |
| `geminiModel` | string | Installation | No | `gemini-2.0-flash` | Gemini model for generation |
| `systemPrompt` | paragraph | Installation | No | — | Full system prompt for Gemini |
| `flairName` | string | Installation | No | *(empty)* | Post flair to apply (exact match) |

---

## Redis Keys (unchanged)

| Key | Value | Purpose |
|-----|-------|---------|
| `last_episode_guid` | string (video ID) | Deduplication — last processed video |
| `last_episode_post_id` | string (post ID) | Currently pinned post |
| `episode_checker_job_id` | string (job ID) | Scheduler job for cancellation |

---

## Domain Allowlist (unchanged)

| Domain | Purpose | Global Allowlist? |
|--------|---------|-------------------|
| `youtube.googleapis.com` | YouTube Data API v3 | **Yes** |
| `generativelanguage.googleapis.com` | Gemini API | **Yes** |

Both domains are on the Devvit global allowlist. No additional approval needed.

---

## Error Handling (unchanged)

| Scenario | Handling |
|----------|----------|
| Missing settings | Log error, return early — no crash |
| YouTube API down | Catch, log, retry next cron cycle |
| Gemini API down | Catch, log, retry next cron cycle |
| Flair template not found | Log warning, post created without flair |
| Pin fails | Log error, post still exists |
| Duplicate video ID | Early return via Redis check |

---

## Future Enhancements

- **YouTube source types** — Support channel IDs (auto-resolve to uploads playlist), individual video IDs, and search queries
- **Configurable cron** — Let mods adjust check frequency via a setting
- **Dry-run mode** — Preview generated posts without publishing
- **Multi-playlist** — Monitor multiple playlists with different prompts
- **Post template fallback** — If Gemini fails, use a simple template with just the video embed and metadata
- **Modmail notification** — Alert mods when a new post is created
