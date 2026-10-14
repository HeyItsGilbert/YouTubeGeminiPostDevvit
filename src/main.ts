import { Devvit, SettingScope } from "@devvit/public-api";

import { fetchPlaylistVideos, fetchYouTubeVideoById } from "./episodeChecker.js";
import { generateEpisodePost } from "./llmClient.js";
import { GEMINI_MODELS, DEFAULT_GEMINI_MODEL, describeModel, describeThinkingLevel, resolveThinkingLevel, thinkingLevelsFor } from "./geminiModels.js";
import type { ThinkingLevel } from "./types.js";
import { createEpisodePost, updateEpisodePost, applyBotFlair, applyFlair, managePins } from "./postManager.js";
import { getAllVideoRecords, setVideoRecord, deleteVideoRecord, findVideoByPostId } from "./videoRegistry.js";
import { assemblePostBody, applyPlaceholders, matchesExclusionFilter, isPrivateVideo } from "./postUtils.js";
import { ensureCheckerScheduled } from "./checkerSchedule.js";

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: {
    domains: [
      'youtube.googleapis.com',          // YouTube Data API (video detection)
      'generativelanguage.googleapis.com', // Gemini API (post generation)
    ],
  },
});

// ---------------------------------------------------------------------------
// App settings — Installation-scoped so each subreddit configures its own
// ---------------------------------------------------------------------------

Devvit.addSettings([
  // --- YouTube Source ---
  {
    type: 'string',
    name: 'youtubePlaylistId',
    label: 'YouTube Playlist ID',
    helpText: 'Playlist to monitor for new videos. You can use a regular playlist ID (e.g. PLabc123) or a channel ID (e.g. UCabc123) — the app will automatically use that channel\'s Uploads playlist, which is always sorted newest-first.',
    scope: SettingScope.Installation,
  },
  {
    type: 'string',
    name: 'excludeTitleKeywords',
    label: 'Exclude Title Keywords (optional)',
    helpText: 'Comma-separated list of keywords. Videos whose titles contain any of these words are permanently skipped (e.g. "trailer, short, bonus").',
    defaultValue: '',
    scope: SettingScope.Installation,
  },

  // --- Gemini Configuration (model and thinking level live in "Configure bot") ---
  {
    type: 'paragraph',
    name: 'systemPrompt',
    label: 'System Prompt',
    helpText: 'Instructions for Gemini. First line of output is used as the post title. The user message will include: Title, Published date, Link, and Description. See SystemPrompt.example.md for a sample.',
    scope: SettingScope.Installation,
  },

  // --- Bot Identity ---
  {
    type: 'string',
    name: 'botFlairEmoji',
    label: 'Bot Flair Emoji (optional)',
    helpText: 'Emoji shown in the bot\'s author flair on this subreddit, e.g. 🎙️',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'string',
    name: 'botFlairText',
    label: 'Bot Flair Text (optional)',
    helpText: 'Display name shown in the bot\'s author flair on this subreddit, e.g. "Podcast Bot". Combined with the emoji if both are set.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },

  // --- Reddit Post Options ---
  {
    type: 'paragraph',
    name: 'prependText',
    label: 'Prepend Text (optional)',
    helpText: 'Text added to the top of every generated post body. Useful for recurring links or disclaimers.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'appendText',
    label: 'Append Text (optional)',
    helpText: 'Text added to the bottom of every generated post body. Useful for footers or recurring links.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'string',
    name: 'flairName',
    label: 'Post Flair (optional)',
    helpText: 'Exact name of a post flair template on this subreddit. Leave blank for no flair.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },

  // --- Approval Gate ---
  {
    type: 'string',
    name: 'notificationMods',
    label: 'Notification Recipients (optional)',
    helpText: 'Comma-separated Reddit usernames to notify when a post is queued for approval (e.g. "alice, bob"). Leave blank to send to the general mod inbox instead.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
  {
    type: 'boolean',
    name: 'requireModApproval',
    label: 'Hold posts for mod approval',
    helpText: 'When enabled, generated posts are queued in the mod inbox for review instead of being submitted immediately. Use "Review pending post" in the subreddit\'s "…" menu to publish, discard, or reject.',
    defaultValue: false,
    scope: SettingScope.Installation,
  },
  {
    type: 'number',
    name: 'autoApproveWindowMinutes',
    label: 'Auto-approve window (minutes, 0 = off)',
    helpText: 'Only applies when "Hold posts for mod approval" is on. The post auto-publishes after this many minutes if no mod takes action. Set to 0 to require explicit mod approval with no timeout.',
    defaultValue: 0,
    scope: SettingScope.Installation,
  },
]);


// ---------------------------------------------------------------------------
// Redis key constants
// ---------------------------------------------------------------------------

const REDIS_KEY_GOOGLE_API_KEY = 'google_api_key';
const REDIS_KEY_PENDING_POST = 'pending_post';
const REDIS_KEY_PENDING_POST_JOB_ID = 'pending_post_job_id';
const REDIS_KEY_STICKY_SLOT = 'last_episode_sticky_slot';
const REDIS_KEY_GEMINI_MODEL = 'gemini_model';
const REDIS_KEY_THINKING_LEVEL = 'gemini_thinking_level';
const REDIS_KEY_REGENERATE_DRAFT_PREFIX = 'regenerate_draft:';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingPost {
  title: string;
  body: string;
  url: string;
  videoId: string;
  videoTitle: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Failure notification helper
// ---------------------------------------------------------------------------

type RedditClient = Devvit.Context['reddit'];

/** Closing line of failure PMs: things a mod can act on (they can't read app logs). */
const FAILURE_HELP = 'Please try again later. If it keeps failing, check the Google API key in "Configure bot" (in the subreddit\'s "…" menu) and the app settings in Mod Tools → Installed Apps, or report it at https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues.';

/**
 * Send a PM (usually a failure report) to the appropriate recipients.
 *
 * Priority: if notificationMods are configured, PM each of them.
 * Otherwise fall back to the individual mod who triggered the action
 * (fallbackRecipient). If neither is available, only log — never throws.
 */
async function sendFailureNotification(
  reddit: RedditClient,
  notificationMods: string[],
  fallbackRecipient: string | null | undefined,
  subject: string,
  text: string,
): Promise<void> {
  const recipients = notificationMods.length > 0
    ? notificationMods
    : (fallbackRecipient ? [fallbackRecipient] : []);

  for (const recipient of recipients) {
    try {
      await reddit.sendPrivateMessage({ to: recipient, subject, text });
      console.log(`[bot] Sent failure notification PM to u/${recipient}`);
    } catch (pmErr) {
      console.error(`[bot] Failed to send failure notification to u/${recipient}: ${pmErr}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Playtest Install detection — gates Testing Tools
// ---------------------------------------------------------------------------

/**
 * True on a Playtest Install. Pre-release versions created by
 * `devvit playtest` (or `devvit upload --bump prerelease`) carry a fourth
 * version segment, e.g. `0.1.10.3`. Testing Tools are only offered here so
 * Moderators on real installs never see them.
 */
function isPlaytestInstall(context: { appVersion: string }): boolean {
  return context.appVersion.split('.').length > 3;
}

// ---------------------------------------------------------------------------
// Gemini model + thinking level — advanced, optional overrides chosen in
// "Configure bot" and stored in Redis. Unset means DEFAULT_GEMINI_MODEL with
// no reasoning_effort (the model decides how much to think).
// ---------------------------------------------------------------------------

/** Select value meaning "no override". */
const DEFAULT_CHOICE = 'default';

async function getGeminiChoice(
  context: Pick<Devvit.Context, 'redis'>,
): Promise<{ model: string; isDefaultModel: boolean; thinkingLevel: ThinkingLevel | undefined }> {
  const [storedModel, storedLevel] = await Promise.all([
    context.redis.get(REDIS_KEY_GEMINI_MODEL),
    context.redis.get(REDIS_KEY_THINKING_LEVEL),
  ]);
  const model = storedModel || DEFAULT_GEMINI_MODEL;
  return { model, isDefaultModel: !storedModel, thinkingLevel: resolveThinkingLevel(model, storedLevel) };
}

/** `current` null = the recommended default. A model a newer build dropped stays listed so a save never silently switches it. */
function modelSelectField(current: string | null) {
  const defaultName = GEMINI_MODELS.find(m => m.id === DEFAULT_GEMINI_MODEL)?.name ?? DEFAULT_GEMINI_MODEL;
  const options = [
    { label: `Recommended: ${defaultName}`, value: DEFAULT_CHOICE },
    ...GEMINI_MODELS.map(m => ({ label: describeModel(m), value: m.id })),
  ];
  if (current && !GEMINI_MODELS.some(m => m.id === current)) {
    options.push({ label: `${current} (no longer listed)`, value: current });
  }
  return {
    type: 'select' as const,
    name: 'geminiModel',
    label: 'Gemini model',
    helpText: 'Leave on Recommended unless you need a specific model. Recommended follows Google\'s newest Flash model.',
    options,
    defaultValue: [current ?? DEFAULT_CHOICE],
    required: true,
  };
}

function customizeThinkingField(label: string, defaultValue: boolean) {
  return {
    type: 'boolean' as const,
    name: 'customizeThinking',
    label,
    helpText: 'Off: the model decides how much to think (recommended). On: pick a level on the next screen.',
    defaultValue,
  };
}

function thinkingLevelSelectField(model: string, current: ThinkingLevel | undefined) {
  return {
    type: 'select' as const,
    name: 'thinkingLevel',
    label: 'Thinking level',
    helpText: 'More thinking can improve the discussion but is slower; Gemini has 20 seconds to answer.',
    options: [
      { label: 'Model default (recommended)', value: DEFAULT_CHOICE },
      ...thinkingLevelsFor(model).map(level => ({ label: describeThinkingLevel(level), value: level })),
    ],
    defaultValue: [current ?? DEFAULT_CHOICE],
    required: true,
  };
}

// ---------------------------------------------------------------------------
// Configure bot — Google API key (stored in Redis, kept out of the visible
// settings UI), pin slot, and under Advanced the Gemini model; then, if asked
// for, a second form with the levels that model accepts
// ---------------------------------------------------------------------------

const configureThinkingLevelForm = Devvit.createForm(
  (data: { [key: string]: unknown }) => ({
    title: 'Configure bot: thinking level',
    description: `Levels ${String(data.model)} accepts. Saved for every check; "Regenerate discussion" can override it per run.`,
    fields: [thinkingLevelSelectField(String(data.model), data.thinkingLevel as ThinkingLevel | undefined)],
    acceptLabel: 'Save',
    cancelLabel: 'Keep current',
  }),
  async ({ values }, context) => {
    const { model } = await getGeminiChoice(context);
    const level = resolveThinkingLevel(model, (values.thinkingLevel as string[] | undefined)?.[0]);
    await (level ? context.redis.set(REDIS_KEY_THINKING_LEVEL, level) : context.redis.del(REDIS_KEY_THINKING_LEVEL));
    context.ui.showToast(level ? `${model} will use ${level} thinking.` : `${model} will decide how much to think.`);
  }
);

const configureBotForm = Devvit.createForm(
  (data: { [key: string]: unknown }) => ({
    title: 'Configure bot',
    description: 'The Google API key is stored in this subreddit\'s Redis store, not in the app settings. Get a free key from Google Cloud Console with YouTube Data API v3 and Generative Language API enabled.',
    fields: [
      {
        type: 'string',
        name: 'apiKey',
        label: 'Google API Key',
        helpText: data.hasApiKey === true ? 'A key is saved. Leave blank to keep it.' : 'Required before the bot can run.',
        required: data.hasApiKey !== true,
      },
      {
        type: 'select',
        name: 'pinSlot',
        label: 'Pin slot',
        helpText: 'Which of the subreddit\'s two sticky slots new episode posts take.',
        options: [
          { label: '1 (top)', value: '1' },
          { label: '2', value: '2' },
        ],
        defaultValue: [data.currentSlot === 2 ? '2' : '1'],
        required: true,
      },
      {
        type: 'group',
        label: 'Advanced (optional)',
        fields: [
          modelSelectField(typeof data.storedModel === 'string' ? data.storedModel : null),
          customizeThinkingField('Choose a thinking level', data.hasThinkingLevel === true),
        ],
      },
    ],
    acceptLabel: 'Save',
    cancelLabel: 'Cancel',
  }),
  async ({ values }, context) => {
    const key = (values.apiKey as string | undefined)?.trim();
    const slot = (values.pinSlot as string[] | undefined)?.[0] === '2' ? '2' : '1';
    const previous = await getGeminiChoice(context);
    const picked = (values.geminiModel as string[] | undefined)?.[0];
    const storedModel = picked && picked !== DEFAULT_CHOICE ? picked : null;
    const model = storedModel ?? DEFAULT_GEMINI_MODEL;
    const customizeThinking = values.customizeThinking === true && thinkingLevelsFor(model).length > 0;
    await Promise.all([
      key ? context.redis.set(REDIS_KEY_GOOGLE_API_KEY, key) : Promise.resolve(),
      context.redis.set(REDIS_KEY_STICKY_SLOT, slot),
      storedModel ? context.redis.set(REDIS_KEY_GEMINI_MODEL, storedModel) : context.redis.del(REDIS_KEY_GEMINI_MODEL),
      // A level picked for another model may not apply.
      customizeThinking && model === previous.model ? Promise.resolve() : context.redis.del(REDIS_KEY_THINKING_LEVEL),
    ]);
    context.ui.showToast(key ? `API key saved; ${model}; pin slot ${slot}.` : `Saved ${model}; pin slot ${slot}.`);
    if (customizeThinking) {
      context.ui.showForm(configureThinkingLevelForm, {
        model,
        thinkingLevel: model === previous.model ? previous.thinkingLevel ?? null : null,
      });
    }
  }
);

Devvit.addMenuItem({
  label: 'Configure bot',
  description: 'API key, pin slot, and Gemini model.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    await ensureCheckerScheduled(context, 'heal');
    const [apiKey, current, gemini] = await Promise.all([
      context.redis.get(REDIS_KEY_GOOGLE_API_KEY),
      context.redis.get(REDIS_KEY_STICKY_SLOT),
      getGeminiChoice(context),
    ]);
    context.ui.showForm(configureBotForm, {
      hasApiKey: Boolean(apiKey),
      currentSlot: current === '2' ? 2 : 1,
      storedModel: gemini.isDefaultModel ? null : gemini.model,
      hasThinkingLevel: gemini.thinkingLevel !== undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// Review pending post — one form for Publish / Discard / Reject
// ---------------------------------------------------------------------------

/**
 * Remove the Pending Post and its auto-approve timer. Returns the removed
 * Pending Post, or null if none was pending.
 */
async function clearPendingPost(
  redis: Devvit.Context['redis'],
  scheduler: Devvit.Context['scheduler'],
): Promise<PendingPost | null> {
  const pendingJson = await redis.get(REDIS_KEY_PENDING_POST);
  if (!pendingJson) {
    return null;
  }
  await cancelAutoApproveJob(redis, scheduler);
  await redis.del(REDIS_KEY_PENDING_POST);
  return JSON.parse(pendingJson) as PendingPost;
}

async function cancelAutoApproveJob(
  redis: Devvit.Context['redis'],
  scheduler: Devvit.Context['scheduler'],
): Promise<void> {
  const existingJobId = await redis.get(REDIS_KEY_PENDING_POST_JOB_ID);
  if (existingJobId) {
    try { await scheduler.cancelJob(existingJobId); } catch { /* already fired */ }
    await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);
  }
}

const reviewPendingPostForm = Devvit.createForm(
  (data: { [key: string]: unknown }) => ({
    title: 'Review pending post',
    description: `Video: ${String(data.videoTitle ?? '')}`,
    fields: [
      {
        type: 'select',
        name: 'action',
        label: 'Action',
        options: [
          { label: 'Publish', value: 'publish' },
          { label: 'Discard (the video is treated as unseen on the next check)', value: 'discard' },
          { label: 'Reject (never post this video)', value: 'reject' },
        ],
        defaultValue: ['publish'],
        required: true,
      },
      {
        type: 'string',
        name: 'postTitle',
        label: 'Post Title',
        defaultValue: String(data.title ?? ''),
        required: true,
      },
      {
        type: 'paragraph',
        name: 'postBody',
        label: 'Discussion Comment Body',
        defaultValue: String(data.body ?? ''),
        required: true,
      },
    ],
    acceptLabel: 'Submit',
    cancelLabel: 'Close',
  }),
  async ({ values }, context) => {
    const { redis, scheduler } = context;
    const action = (values.action as string[] | undefined)?.[0] ?? 'publish';

    if (action === 'discard') {
      const pending = await clearPendingPost(redis, scheduler);
      if (!pending) {
        context.ui.showToast('No pending post found. It may have already been published, discarded, or rejected.');
        return;
      }
      await deleteVideoRecord(redis, pending.videoId);
      context.ui.showToast('Pending post discarded.');
      return;
    }

    if (action === 'reject') {
      const pending = await clearPendingPost(redis, scheduler);
      if (!pending) {
        context.ui.showToast('No pending post found. It may have already been published, discarded, or rejected.');
        return;
      }
      await setVideoRecord(redis, pending.videoId, {
        title: pending.videoTitle,
        status: 'rejected',
        processedAt: new Date().toISOString(),
      });
      context.ui.showToast(`Rejected "${pending.videoTitle}". It will not be posted.`);
      return;
    }

    const pendingJson = await redis.get(REDIS_KEY_PENDING_POST);
    if (!pendingJson) {
      context.ui.showToast('No pending post found. It may have already been published, discarded, or rejected.');
      return;
    }

    // Write edited content back to Redis before triggering the post job
    const pending: PendingPost = JSON.parse(pendingJson);
    pending.title = (values.postTitle as string).trim();
    pending.body = (values.postBody as string).trim();
    await redis.set(REDIS_KEY_PENDING_POST, JSON.stringify(pending));

    // Cancel any scheduled auto-approve job — we're posting immediately
    await cancelAutoApproveJob(redis, scheduler);

    const currentUser = await context.reddit.getCurrentUser();
    await scheduler.runJob({ name: 'post_pending_episode', runAt: new Date(), data: { triggeredBy: currentUser?.username ?? null } });
    context.ui.showToast('Publishing. The post appears within 30 seconds; otherwise you\'ll get a message.');
  }
);

Devvit.addMenuItem({
  label: 'Review pending post',
  description: 'Publish, edit, discard, or reject the queued post.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    await ensureCheckerScheduled(context, 'heal');
    const pendingJson = await context.redis.get(REDIS_KEY_PENDING_POST);
    if (!pendingJson) {
      context.ui.showToast('No post is pending approval.');
      return;
    }
    const pending: PendingPost = JSON.parse(pendingJson);
    context.ui.showForm(reviewPendingPostForm, {
      title: pending.title,
      body: pending.body,
      videoTitle: pending.videoTitle,
    });
  },
});

// ---------------------------------------------------------------------------
// Video checker — scheduler job
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'check_new_episodes',
  onRun: async (event, context) => {
    const { redis, reddit, settings } = context;
    // Hoisted so the catch block can reference it even if an early error occurs
    let notificationMods: string[] = [];

    try {
      // 1. Read all settings
      const [
        googleApiKey,
        playlistId,
        excludeKeywords,
        gemini,
        systemPrompt,
        botFlairEmoji,
        botFlairText,
        prependText,
        appendText,
        flairName,
        requireModApproval,
        autoApproveWindowMinutes,
        notificationModsSetting,
      ] = await Promise.all([
        redis.get(REDIS_KEY_GOOGLE_API_KEY),
        settings.get<string>('youtubePlaylistId'),
        settings.get<string>('excludeTitleKeywords').then(v => v || ''),
        getGeminiChoice(context),
        settings.get<string>('systemPrompt'),
        settings.get<string>('botFlairEmoji').then(v => v || ''),
        settings.get<string>('botFlairText').then(v => v || ''),
        settings.get<string>('prependText').then(v => v || ''),
        settings.get<string>('appendText').then(v => v || ''),
        settings.get<string>('flairName').then(v => v || ''),
        settings.get<boolean>('requireModApproval').then(v => v ?? false),
        settings.get<number>('autoApproveWindowMinutes').then(v => v ?? 0),
        settings.get<string>('notificationMods').then(v => v || ''),
      ]);
      notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

      // Manual runs always end in something the mod can see: a new post, a
      // failure PM, or one of these PMs. Cron runs stay quiet when there's
      // nothing to do, so an unconfigured install isn't PM'd every 30 minutes.
      const manual = event.data?.manual === true;
      const tellTriggeringMod = async (subject: string, text: string): Promise<void> => {
        if (manual) {
          await sendFailureNotification(reddit, [], await redis.get('check_triggered_by'), subject, text);
        }
      };

      // 2. Validate required settings
      const notConfigured = async (problem: string): Promise<void> => {
        console.error(`[bot] ${problem}`);
        await tellTriggeringMod('Video check could not run', problem);
      };
      if (!googleApiKey) {
        await notConfigured('No Google API key is saved. Add one with "Configure bot" in the subreddit\'s "…" menu.');
        return;
      }
      if (!playlistId) {
        await notConfigured('No YouTube Playlist ID is set. Add it in the app settings (Mod Tools → Installed Apps).');
        return;
      }
      if (!systemPrompt) {
        await notConfigured('No System Prompt is set. Add it in the app settings (Mod Tools → Installed Apps).');
        return;
      }

      // 3. Fetch playlist videos (newest first, full list) and every registry
      //    entry in parallel — these are independent reads, and resolving them
      //    concurrently (rather than one giant hGet-per-video loop below) keeps
      //    the job well clear of Devvit's per-invocation execution timeout as
      //    the playlist grows.
      const subredditName = context.subredditName!;
      const log = (msg: string) => console.log(`[bot:${subredditName}] ${msg}`);
      log(`Checking playlist ${playlistId}...`);
      const [videos, videoRecords] = await Promise.all([
        fetchPlaylistVideos(googleApiKey, playlistId),
        getAllVideoRecords(redis),
      ]);

      if (!videos.length) {
        log('No videos found in YouTube playlist.');
        await tellTriggeringMod(
          'Video check: no videos found',
          `The YouTube playlist ${playlistId} returned no videos. Check the YouTube Playlist ID in the app settings (Mod Tools → Installed Apps).`,
        );
        return;
      }

      // 4. Walk videos newest-first; find the first unregistered, non-excluded video.
      //    Private videos are tracked in the registry (status: 'private') so that when
      //    they become public they are detected as new rather than skipped. Only videos
      //    with no record are marked private — a video that was already handled (e.g.
      //    posted) keeps its status if it goes private. A formerly-private video that
      //    goes public in the same run as a newer video is left with its 'private'
      //    registry entry so it is picked up by the next run.
      // Testing Tool: passed only by the playtest-gated "Check for new videos" form.
      const forceRepost = event.data?.forceRepost === true;
      if (forceRepost) {
        log('Force repost requested — bypassing registry check for newest video');
      }

      let episodeToPost = null;

      for (const video of videos) {
        // Track never-seen private videos so we can detect when they go public.
        if (isPrivateVideo(video)) {
          const existingRecord = videoRecords[video.guid] ?? null;
          if (!existingRecord) {
            log(`Registering private video ${video.guid} for future tracking`);
            await setVideoRecord(redis, video.guid, {
              title: video.title,
              status: 'private',
              processedAt: new Date().toISOString(),
            });
          }
          continue;
        }

        // Skip registry check for the very first (newest) video when forceRepost is set
        let wasPreviouslyPrivate = false;
        if (!forceRepost || episodeToPost !== null) {
          const record = videoRecords[video.guid] ?? null;
          if (record) {
            if (record.status === 'private') {
              // Video was private before — it's now public, treat as new
              log(`"${video.title}" (${video.guid}) was private, now public — treating as new`);
              wasPreviouslyPrivate = true;
            } else {
              log(`Skipping "${video.title}" (${video.guid}) — already ${record.status}`);
              continue; // Already handled — keep scanning for gaps
            }
          }
        }

        if (matchesExclusionFilter(video.title, excludeKeywords)) {
          log(`Excluding video "${video.title}" (matches exclusion filter)`);
          await setVideoRecord(redis, video.guid, {
            title: video.title,
            status: 'excluded',
            processedAt: new Date().toISOString(),
          });
          continue;
        }

        if (!episodeToPost) {
          // Newest unregistered, non-excluded video — this is the one to post
          episodeToPost = video;
        } else if (!wasPreviouslyPrivate) {
          // Older brand-new unregistered video — mark as skipped so it's never posted
          log(`Skipping "${video.title}" (${video.guid}) — older than the video to post`);
          await setVideoRecord(redis, video.guid, {
            title: video.title,
            status: 'skipped',
            processedAt: new Date().toISOString(),
          });
          // else: formerly-private video that just became public but there's a newer video
          // to post this run — leave its registry entry as 'private' so the next run
          // detects it as newly public and posts it then.
        }
      }

      if (!episodeToPost) {
        log('No new video to post.');
        await tellTriggeringMod(
          'Video check: nothing new',
          `The bot checked the playlist for r/${subredditName}. Every video has already been posted, skipped, or excluded, so there is nothing new to post.`,
        );
        return;
      }

      const episode = episodeToPost;
      log(`New video detected: "${episode.title}"`);

      // A Pending Post blocks new generation until a mod resolves it, so the
      // Gemini call isn't repeated every run while the post waits for approval.
      // Force-repost always queues so mods can test the approval flow.
      const holdForApproval = requireModApproval || forceRepost;
      if (holdForApproval && await redis.get(REDIS_KEY_PENDING_POST)) {
        log('A post is already pending mod approval. Skipping until it is published, discarded, or rejected.');
        await tellTriggeringMod(
          'Video check: a post is awaiting approval',
          `A generated post is waiting for review on r/${subredditName}. Use "Review pending post" in the subreddit's "…" menu to publish, discard, or reject it; the bot won't generate another post until then.`,
        );
        return;
      }

      // 5. Generate post content via Gemini
      log('Calling Gemini API...');
      const { title, body: rawBody } = await generateEpisodePost(googleApiKey, episode, systemPrompt, gemini.model, gemini.thinkingLevel);
      log(`Generated title: "${title}"`);

      const body = assemblePostBody(
        applyPlaceholders(prependText, episode),
        rawBody,
        applyPlaceholders(appendText, episode),
      );

      // 6. Queue for mod approval, or post immediately
      if (holdForApproval) {
        const pendingPost: PendingPost = {
          title,
          body,
          url: episode.link,
          videoId: episode.guid,
          videoTitle: episode.title,
          generatedAt: new Date().toISOString(),
        };
        await redis.set(REDIS_KEY_PENDING_POST, JSON.stringify(pendingPost));
        await setVideoRecord(redis, episode.guid, {
          title: episode.title,
          status: 'pending',
          processedAt: new Date().toISOString(),
        });

        // Schedule auto-approve if a window is configured
        if (autoApproveWindowMinutes > 0) {
          const autoApproveAt = new Date(Date.now() + autoApproveWindowMinutes * 60 * 1000);
          const jobId = await context.scheduler.runJob({
            name: 'post_pending_episode',
            runAt: autoApproveAt,
          });
          await redis.set(REDIS_KEY_PENDING_POST_JOB_ID, jobId);
          log(`Post queued for auto-approval in ${autoApproveWindowMinutes} minute(s) — job ${jobId}`);
        } else {
          log('Post queued pending explicit mod approval.');
        }

        // Send notification (non-fatal — post is safely stored in Redis regardless)
        // Message 1: notification with instructions
        const autoApproveNote = autoApproveWindowMinutes > 0
          ? `\n\nThis post will **auto-publish in ${autoApproveWindowMinutes} minute${autoApproveWindowMinutes === 1 ? '' : 's'}** if no mod takes action.`
          : '';
        const notificationBody = [
          `**New episode ready to review:** ${episode.title}`,
          ``,
          `**Video:** ${episode.link}`,
          ``,
          `Use **"Review pending post"** in the **"…"** menu on r/${subredditName} to edit the post, then publish it, discard it (the video is treated as unseen on the next check), or reject the video (never post it).`,
          autoApproveNote,
        ].join('\n');

        // Message 2: the generated post content
        const postPreviewBody = [
          `**Title:** ${title}`,
          ``,
          `---`,
          ``,
          body.length > 1000 ? body.slice(0, 1000) + '\n\n*(preview truncated)*' : body,
        ].join('\n');

        if (notificationMods.length > 0) {
          // PMs have no reply API, so combine both sections into one message
          const combinedPmBody = [notificationBody, '', '---', '', postPreviewBody].join('\n');
          for (const modUsername of notificationMods) {
            try {
              await reddit.sendPrivateMessage({
                to: modUsername,
                subject: `New episode ready: ${title}`,
                text: combinedPmBody,
              });
              log(`Sent pending-post notification PM to u/${modUsername}`);
            } catch (pmErr) {
              console.error(`[bot:${subredditName}] Failed to send notification PM to u/${modUsername}: ${pmErr}`);
            }
          }
        } else {
          // Mod inbox conversations are read-only, so combine both sections
          try {
            const combinedBody = [notificationBody, '', '---', '', postPreviewBody].join('\n');
            const sub = await reddit.getSubredditByName(subredditName);
            await reddit.modMail.createModInboxConversation({
              subredditId: sub.id,
              subject: `New episode ready: ${title}`,
              bodyMarkdown: combinedBody,
            });
            log('Sent modmail notification for pending post.');
          } catch (mailErr) {
            console.error(`[bot:${subredditName}] Failed to send modmail notification: ${mailErr}`);
          }
        }

        return;
      }

      // 7. Immediate post path (requireModApproval = false)
      const { postId, commentId } = await createEpisodePost(reddit, subredditName, title, episode.link, body);
      log(`Created post ${postId} with discussion comment ${commentId}`);

      // 8. Apply post flair, bot author flair, and pin the new post — these
      //    are independent Reddit API calls that only need postId, so run
      //    them concurrently instead of one after another. applyFlair and
      //    applyBotFlair catch and log their own errors internally; a
      //    managePins() failure still propagates and is fatal, same as before.
      await Promise.all([
        flairName ? applyFlair(reddit, subredditName, postId, flairName) : Promise.resolve(),
        applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText),
        managePins(reddit, redis, postId),
      ]);

      // 9. Persist to registry
      await setVideoRecord(redis, episode.guid, {
        title: episode.title,
        status: 'posted',
        postId,
        commentId,
        processedAt: new Date().toISOString(),
      });

      console.log(`[bot] Post complete: "${title}"`);
    } catch (err) {
      console.error(`[bot] Video checker failed: ${err}`);
      const triggeredBy = await redis.get('check_triggered_by');
      await sendFailureNotification(
        reddit,
        notificationMods,
        triggeredBy,
        'Video check failed',
        `The video check on r/${context.subredditName!} failed with the following error:\n\n    ${err}\n\n${FAILURE_HELP}`,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Post pending episode — scheduler job
// Handles both explicit mod approval (runAt: new Date()) and auto-approve timer
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'post_pending_episode',
  onRun: async (event, context) => {
    const { redis, reddit, settings } = context;
    let notificationMods: string[] = [];

    try {
      const pendingJson = await redis.get(REDIS_KEY_PENDING_POST);
      if (!pendingJson) {
        // Already published, discarded, or rejected — nothing to do
        console.log('[bot] post_pending_episode: no pending post found (already published, discarded, or rejected).');
        return;
      }

      const pending: PendingPost = JSON.parse(pendingJson);
      const subredditName = context.subredditName!;

      const flairName = (await settings.get<string>('flairName')) || '';
      const botFlairEmoji = (await settings.get<string>('botFlairEmoji')) || '';
      const botFlairText = (await settings.get<string>('botFlairText')) || '';
      const notificationModsSetting = (await settings.get<string>('notificationMods')) || '';
      notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

      console.log(`[bot] Posting pending episode: "${pending.title}"`);
      const { postId, commentId } = await createEpisodePost(reddit, subredditName, pending.title, pending.url, pending.body);
      console.log(`[bot] Created post ${postId} with discussion comment ${commentId}`);

      if (flairName) {
        await applyFlair(reddit, subredditName, postId, flairName);
      }
      await applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText);
      await managePins(reddit, redis, postId);

      await setVideoRecord(redis, pending.videoId, {
        title: pending.videoTitle,
        status: 'posted',
        postId,
        commentId,
        processedAt: new Date().toISOString(),
      });

      // Clean up pending state
      await redis.del(REDIS_KEY_PENDING_POST);
      await redis.del(REDIS_KEY_PENDING_POST_JOB_ID);

      console.log(`[bot] Pending episode posted: "${pending.title}"`);
    } catch (err) {
      console.error(`[bot] Failed to post pending episode: ${err}`);
      // Publish passes the mod who pressed it; the auto-approve timer doesn't.
      const triggeredBy = typeof event.data?.triggeredBy === 'string'
        ? event.data.triggeredBy
        : await redis.get('check_triggered_by');
      await sendFailureNotification(
        reddit,
        notificationMods,
        triggeredBy,
        'Episode post failed',
        `Failed to post the pending episode on r/${context.subredditName} with error:\n\n    ${err}\n\nThe episode content is still saved. Try "Review pending post" in the subreddit's "…" menu to retry.`,
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Auto-schedule on app install and on every subsequent version upgrade.
// Devvit cron jobs created dynamically in app code (as opposed to jobs
// declared in devvit.json) are not guaranteed to survive every app version
// deploy, and AppInstall only fires once on first install — so without the
// AppUpgrade leg here, a mod updating the app version can silently lose the
// recurring check_new_episodes job with no automatic recovery.
// ---------------------------------------------------------------------------

Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: async (_event, context) => {
    // Replace any checker cron left by an older version with a fresh one.
    await ensureCheckerScheduled(context, 'reset');
  },
});

// AppInstall/AppUpgrade alone have left installs with no checker job and no
// log line, so subreddit activity also re-verifies it (throttled to once per
// 30 minutes by ensureCheckerScheduled).
Devvit.addTrigger({
  events: ['PostSubmit', 'CommentSubmit'],
  onEvent: async (_event, context) => {
    await ensureCheckerScheduled(context, 'heal');
  },
});

// ---------------------------------------------------------------------------
// Manual trigger (moderator menu action)
// ---------------------------------------------------------------------------

async function triggerCheck(context: Devvit.Context, forceRepost: boolean): Promise<void> {
  try {
    const currentUser = await context.reddit.getCurrentUser();
    if (currentUser) {
      await context.redis.set('check_triggered_by', currentUser.username);
    }
    await context.scheduler.runJob({
      name: 'check_new_episodes',
      runAt: new Date(),
      data: { forceRepost, manual: true },
    });
    context.ui.showToast('Checking for new videos. A new post appears within 30 seconds; otherwise you\'ll get a message.');
  } catch (err) {
    console.error(`[bot] Manual trigger failed: ${err}`);
    context.ui.showToast('Couldn\'t start the video check. Please try again.');
  }
}

/** Shown instead of an immediate check on a Playtest Install only. */
const playtestCheckForm = Devvit.createForm(
  {
    title: 'Check for new videos',
    description: 'Playtest install — Testing Tools are available.',
    fields: [
      {
        type: 'boolean',
        name: 'forceRepost',
        label: 'Repost newest video even if already posted (always queues for review)',
        defaultValue: false,
      },
    ],
    acceptLabel: 'Check',
    cancelLabel: 'Cancel',
  },
  async ({ values }, context) => {
    await triggerCheck(context, values.forceRepost === true);
  }
);

Devvit.addMenuItem({
  label: 'Check for new videos',
  description: 'Post the newest video now, if there is one.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    await ensureCheckerScheduled(context, 'heal');
    if (isPlaytestInstall(context)) {
      context.ui.showForm(playtestCheckForm);
      return;
    }
    await triggerCheck(context, false);
  },
});

// ---------------------------------------------------------------------------
// Regenerate discussion — post menu action on any Episode Post
// ---------------------------------------------------------------------------

type RegenerateJobData = {
  videoId: string;
  commentId: string;
  systemPrompt: string;
  model: string;
  /** null = the model's default */
  thinkingLevel: ThinkingLevel | null;
  triggeredBy: string | null;
};

Devvit.addSchedulerJob<RegenerateJobData>({
  name: 'regenerate_discussion',
  onRun: async (event, context) => {
    const { redis, reddit, settings } = context;
    const { videoId, commentId, systemPrompt, model, thinkingLevel, triggeredBy } = event.data!;
    let notificationMods: string[] = [];

    try {
      const notificationModsSetting = (await settings.get<string>('notificationMods')) || '';
      notificationMods = notificationModsSetting.split(',').map(u => u.trim()).filter(Boolean);

      const googleApiKey = await redis.get(REDIS_KEY_GOOGLE_API_KEY);
      const botFlairEmoji = (await settings.get<string>('botFlairEmoji')) || '';
      const botFlairText = (await settings.get<string>('botFlairText')) || '';
      const prependText = (await settings.get<string>('prependText')) || '';
      const appendText = (await settings.get<string>('appendText')) || '';

      if (!googleApiKey) {
        throw new Error('No Google API key is saved. Add one with "Configure bot" in the subreddit\'s "…" menu.');
      }

      console.log(`[bot] Fetching video ${videoId} for regeneration...`);
      const episode = await fetchYouTubeVideoById(googleApiKey, videoId);
      if (!episode) {
        throw new Error(`YouTube video ${videoId} was not found. It may have been made private or deleted.`);
      }

      console.log(`[bot] Regenerating discussion for "${episode.title}" with ${model} (thinking: ${thinkingLevel ?? 'model default'})...`);
      const { body: rawBody } = await generateEpisodePost(googleApiKey, episode, systemPrompt, model, thinkingLevel ?? undefined);

      const body = assemblePostBody(
        applyPlaceholders(prependText, episode),
        rawBody,
        applyPlaceholders(appendText, episode),
      );

      await updateEpisodePost(reddit, commentId, body);
      await applyBotFlair(reddit, context.subredditName!, botFlairEmoji, botFlairText);
      console.log(`[bot] Regenerated comment ${commentId}`);
    } catch (err) {
      console.error(`[bot] Regeneration failed: ${err}`);
      await sendFailureNotification(
        reddit,
        notificationMods,
        triggeredBy,
        'Discussion regeneration failed',
        `Regenerating a discussion comment on r/${context.subredditName} failed with the following error:\n\n    ${err}\n\n${FAILURE_HELP}`,
      );
    }
  },
});

async function triggerRegeneration(context: Devvit.Context, data: RegenerateJobData): Promise<void> {
  try {
    await context.scheduler.runJob({ name: 'regenerate_discussion', runAt: new Date(), data });
    context.ui.showToast('Regenerating. The comment updates within 30 seconds; otherwise you\'ll get a message.');
  } catch (err) {
    console.error(`[bot] Regenerate trigger failed: ${err}`);
    context.ui.showToast('Couldn\'t start the regeneration. Please try again.');
  }
}

// Step 1 hands its answers to step 2 through Redis: a form's submit handler
// only receives its own fields. Keyed per mod; expires if step 2 is abandoned.
const REGENERATE_DRAFT_TTL_MS = 60 * 60 * 1000;

const regenerateThinkingLevelForm = Devvit.createForm(
  (data: { [key: string]: unknown }) => ({
    title: 'Regenerate discussion: thinking level',
    description: `Levels ${String(data.model)} accepts. Applies to this regeneration only.`,
    fields: [thinkingLevelSelectField(String(data.model), data.thinkingLevel as ThinkingLevel | undefined)],
    acceptLabel: 'Regenerate',
    cancelLabel: 'Cancel',
  }),
  async ({ values }, context) => {
    const draftKey = REDIS_KEY_REGENERATE_DRAFT_PREFIX + context.userId;
    const draftJson = await context.redis.get(draftKey);
    if (!draftJson) {
      context.ui.showToast('This regeneration expired. Start again from the post menu.');
      return;
    }
    await context.redis.del(draftKey);
    const draft = JSON.parse(draftJson) as RegenerateJobData;
    const level = resolveThinkingLevel(draft.model, (values.thinkingLevel as string[] | undefined)?.[0]);
    await triggerRegeneration(context, { ...draft, thinkingLevel: level ?? null });
  }
);

const regenerateDiscussionForm = Devvit.createForm(
  (data: { [key: string]: unknown }) => ({
    title: 'Regenerate discussion',
    description: `Rewrites the discussion comment for "${String(data.videoTitle ?? '')}". Choices here apply to this regeneration only; the bot's configuration is unchanged.`,
    fields: [
      {
        type: 'paragraph',
        name: 'systemPrompt',
        label: 'System Prompt',
        defaultValue: String(data.systemPrompt ?? ''),
        required: true,
      },
      {
        type: 'group',
        label: 'Advanced (optional)',
        fields: [
          modelSelectField(typeof data.storedModel === 'string' ? data.storedModel : null),
          customizeThinkingField('Choose a thinking level for this run', false),
        ],
      },
    ],
    acceptLabel: 'Regenerate',
    cancelLabel: 'Cancel',
  }),
  async ({ values }, context) => {
    const postId = context.postId;
    const found = postId ? await findVideoByPostId(context.redis, postId) : null;
    if (!found?.record.commentId) {
      context.ui.showToast('Could not find the episode post to regenerate.');
      return;
    }
    const [configured, currentUser] = await Promise.all([
      getGeminiChoice(context),
      context.reddit.getCurrentUser(),
    ]);
    const picked = (values.geminiModel as string[] | undefined)?.[0];
    const model = picked && picked !== DEFAULT_CHOICE ? picked : DEFAULT_GEMINI_MODEL;
    // Without a per-run choice, keep the configured level if it applies to this model.
    const thinkingLevel = resolveThinkingLevel(model, configured.thinkingLevel) ?? null;
    const draft: RegenerateJobData = {
      videoId: found.videoId,
      commentId: found.record.commentId,
      systemPrompt: (values.systemPrompt as string).trim(),
      model,
      thinkingLevel,
      triggeredBy: currentUser?.username ?? null,
    };
    if (values.customizeThinking === true && thinkingLevelsFor(model).length > 0 && context.userId) {
      await context.redis.set(REDIS_KEY_REGENERATE_DRAFT_PREFIX + context.userId, JSON.stringify(draft), {
        expiration: new Date(Date.now() + REGENERATE_DRAFT_TTL_MS),
      });
      context.ui.showForm(regenerateThinkingLevelForm, { model, thinkingLevel });
      return;
    }
    await triggerRegeneration(context, draft);
  }
);

Devvit.addMenuItem({
  label: 'Regenerate discussion',
  description: 'Rewrite this post\'s discussion comment.',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (event, context) => {
    await ensureCheckerScheduled(context, 'heal');
    const found = await findVideoByPostId(context.redis, event.targetId);
    if (!found) {
      context.ui.showToast('This is not an episode post created by the bot.');
      return;
    }
    if (!found.record.commentId) {
      context.ui.showToast('This episode post predates discussion comments and cannot be regenerated.');
      return;
    }
    const [systemPrompt, gemini] = await Promise.all([
      context.settings.get<string>('systemPrompt'),
      getGeminiChoice(context),
    ]);
    context.ui.showForm(regenerateDiscussionForm, {
      videoTitle: found.record.title,
      systemPrompt: systemPrompt || '',
      storedModel: gemini.isDefaultModel ? null : gemini.model,
    });
  },
});

export default Devvit;
