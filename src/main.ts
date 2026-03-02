import { Devvit, SettingScope } from "@devvit/public-api";

import { fetchLatestYouTubeEpisode, fetchYouTubeVideoById, isNewEpisode } from "./episodeChecker.js";
import { generateEpisodePost } from "./llmClient.js";
import { createEpisodePost, updateEpisodePost, applyBotFlair, applyFlair, managePins } from "./postManager.js";

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
// App settings — all Installation-scoped so each subreddit configures its own
// ---------------------------------------------------------------------------

Devvit.addSettings([
  // --- API Access ---
  {
    type: 'string',
    name: 'googleApiKey',
    label: 'Google API Key (YouTube Data API + Gemini)',
    helpText: 'Free from Google Cloud Console. Enable YouTube Data API v3 and Generative Language API.',
    isSecret: true,
    scope: SettingScope.App,
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
    helpText: 'Model ID for post generation (default: gemini-2.0-flash, free tier).',
    defaultValue: 'gemini-2.0-flash',
    scope: SettingScope.Installation,
  },
  {
    type: 'paragraph',
    name: 'systemPrompt',
    label: 'System Prompt',
    helpText: 'Instructions for Gemini. First line of output is used as the post title. The user message will include: Title, Published date, Link, and Description. See SystemPrompt.example.md for a sample.',
    scope: SettingScope.Installation,
  },

  // --- Reddit Post Options ---
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
    type: 'string',
    name: 'videoLinkLabel',
    label: 'Video Link Label (optional)',
    helpText: 'If set, a link to the YouTube video is inserted between the generated body and Append Text. The label becomes the link text, e.g. "Watch on YouTube" → [Watch on YouTube](url). Leave blank to omit.',
    defaultValue: '',
    scope: SettingScope.Installation,
  },
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
]);


// ---------------------------------------------------------------------------
// Video checker — scheduler job
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'check_new_episodes',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;

    try {
      // 1. Read all settings
      const googleApiKey = await settings.get<string>('googleApiKey');
      const playlistId = await settings.get<string>('youtubePlaylistId');
      const geminiModel = (await settings.get<string>('geminiModel')) || 'gemini-2.0-flash';
      const systemPrompt = await settings.get<string>('systemPrompt');
      const botFlairEmoji = (await settings.get<string>('botFlairEmoji')) || '';
      const botFlairText = (await settings.get<string>('botFlairText')) || '';
      const videoLinkLabel = (await settings.get<string>('videoLinkLabel')) || '';
      const prependText = (await settings.get<string>('prependText')) || '';
      const appendText = (await settings.get<string>('appendText')) || '';
      const flairName = (await settings.get<string>('flairName')) || '';

      // 2. Validate required settings
      if (!googleApiKey) {
        console.error('[bot] Google API key not configured. Set it in the app settings.');
        return;
      }
      if (!playlistId) {
        console.error('[bot] YouTube Playlist ID not configured. Set it in the app settings.');
        return;
      }
      if (!systemPrompt) {
        console.error('[bot] System prompt not configured. Set it in the app settings.');
        return;
      }

      // 3. Fetch the latest video from the YouTube playlist
      const subredditName = context.subredditName!;
      console.log(`[bot] Checking playlist ${playlistId} for ${subredditName}...`);
      const episode = await fetchLatestYouTubeEpisode(googleApiKey, playlistId);

      if (!episode) {
        console.log('[bot] No videos found in YouTube playlist.');
        return;
      }

      // 4. Skip if already processed
      if (!(await isNewEpisode(redis, episode))) {
        console.log(`[bot] No new video. Latest: "${episode.title}"`);
        return;
      }

      console.log(`[bot] New video detected: "${episode.title}"`);

      // 5. Generate post content via Gemini
      console.log('[bot] Calling Gemini API...');
      const { title, body: rawBody } = await generateEpisodePost(googleApiKey, episode, systemPrompt, geminiModel);
      console.log(`[bot] Generated title: "${title}"`);

      const videoLink = videoLinkLabel && episode.link ? `[${videoLinkLabel}](${episode.link})` : '';
      const body = [prependText, rawBody, videoLink, appendText].filter(Boolean).join('\n\n');

      // 6. Submit the Reddit post
      const post = await createEpisodePost(reddit, subredditName, title, body);
      console.log(`[bot] Created post ${post.id}`);

      // 7. Apply post flair and bot author flair (if configured)
      if (flairName) {
        await applyFlair(reddit, subredditName, post.id, flairName);
      }
      await applyBotFlair(reddit, subredditName, botFlairEmoji, botFlairText);

      // 8. Pin new post & unpin the previous one
      await managePins(reddit, redis, post.id);

      // 9. Persist state so we don't reprocess this video
      await redis.set('last_episode_guid', episode.guid);
      await redis.set('last_episode_post_id', post.id);

      console.log(`[bot] Post complete: "${title}"`);
    } catch (err) {
      console.error(`[bot] Video checker failed: ${err}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Auto-schedule on app install
// ---------------------------------------------------------------------------

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, context) => {
    try {
      // Cancel any existing job first (idempotent re-install)
      const existingJobId = await context.redis.get('episode_checker_job_id');
      if (existingJobId) {
        try {
          await context.scheduler.cancelJob(existingJobId);
        } catch (_) {
          // Job may already be gone — ignore
        }
      }

      const jobId = await context.scheduler.runJob({
        name: 'check_new_episodes',
        cron: '*/30 * * * *', // Every 30 minutes
      });

      await context.redis.set('episode_checker_job_id', jobId);
      console.log(`[bot] Scheduled video checker — job ID: ${jobId}`);
    } catch (err) {
      console.error(`[bot] Failed to schedule video checker: ${err}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Manual trigger (moderator menu action)
// ---------------------------------------------------------------------------

Devvit.addMenuItem({
  label: 'Check for new videos',
  description: 'Manually check the YouTube playlist for new videos and generate a post if one is found.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Checking for new videos...');
    try {
      await context.scheduler.runJob({
        name: 'check_new_episodes',
        runAt: new Date(),
      });
      context.ui.showToast('Video check triggered! Check logs for results.');
    } catch (err) {
      console.error(`[bot] Manual trigger failed: ${err}`);
      context.ui.showToast('Failed to trigger video check. See logs.');
    }
  },
});

// ---------------------------------------------------------------------------
// Regenerate latest post (re-run Gemini for the already-posted video)
// ---------------------------------------------------------------------------

Devvit.addSchedulerJob({
  name: 'regenerate_latest_post',
  onRun: async (_event, context) => {
    const { redis, reddit, settings } = context;

    try {
      const postId = await redis.get('last_episode_post_id');
      const videoId = await redis.get('last_episode_guid');

      if (!postId || !videoId) {
        console.error('[bot] No previous post found to regenerate.');
        return;
      }

      const googleApiKey = await settings.get<string>('googleApiKey');
      const geminiModel = (await settings.get<string>('geminiModel')) || 'gemini-2.0-flash';
      const systemPrompt = await settings.get<string>('systemPrompt');
      const botFlairEmoji = (await settings.get<string>('botFlairEmoji')) || '';
      const botFlairText = (await settings.get<string>('botFlairText')) || '';
      const videoLinkLabel = (await settings.get<string>('videoLinkLabel')) || '';
      const prependText = (await settings.get<string>('prependText')) || '';
      const appendText = (await settings.get<string>('appendText')) || '';

      if (!googleApiKey || !systemPrompt) {
        console.error('[bot] Missing required settings (googleApiKey, systemPrompt).');
        return;
      }

      console.log(`[bot] Fetching video ${videoId} for regeneration...`);
      const episode = await fetchYouTubeVideoById(googleApiKey, videoId);
      if (!episode) {
        console.error(`[bot] Video ${videoId} not found on YouTube.`);
        return;
      }

      console.log(`[bot] Regenerating post for "${episode.title}"...`);
      const { body: rawBody } = await generateEpisodePost(googleApiKey, episode, systemPrompt, geminiModel);

      const videoLink = videoLinkLabel && episode.link ? `[${videoLinkLabel}](${episode.link})` : '';
      const body = [prependText, rawBody, videoLink, appendText].filter(Boolean).join('\n\n');

      await updateEpisodePost(reddit, postId, body);
      await applyBotFlair(reddit, context.subredditName!, botFlairEmoji, botFlairText);
      console.log(`[bot] Regenerated post ${postId}`);
    } catch (err) {
      console.error(`[bot] Regeneration failed: ${err}`);
    }
  },
});

Devvit.addMenuItem({
  label: 'Regenerate latest post',
  description: 'Re-run Gemini for the last posted video and update the post body.',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    context.ui.showToast('Regenerating post...');
    try {
      await context.scheduler.runJob({
        name: 'regenerate_latest_post',
        runAt: new Date(),
      });
      context.ui.showToast('Regeneration triggered! Check logs for results.');
    } catch (err) {
      console.error(`[bot] Regenerate trigger failed: ${err}`);
      context.ui.showToast('Failed to trigger regeneration. See logs.');
    }
  },
});

export default Devvit;
