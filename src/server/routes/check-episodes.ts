/**
 * `check_new_episodes` scheduler task — the recurring video-check pipeline.
 * Fetches the monitored playlist, skips already-seen videos via the
 * registry, generates a discussion post with Gemini for the newest unseen
 * one, submits it as a link post with a stickied discussion comment, applies
 * flair, and rotates the pin (or queues it for mod approval).
 */

import { Hono } from 'hono';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { context, reddit, redis, scheduler, settings } from '@devvit/web/server';
import type { RedditClient } from '@devvit/reddit';

import { fetchPlaylistVideos } from '../episodeChecker.js';
import { generateEpisodePost } from '../llmClient.js';
import { DEFAULT_GEMINI_MODEL, resolveThinkingLevel } from '../../geminiModels.js';
import type { ThinkingLevel } from '../../types.js';
import { createEpisodePost, applyBotFlair, applyFlair, managePins } from '../postManager.js';
import { getAllVideoRecords, setVideoRecord } from '../videoRegistry.js';
import { assemblePostBody, applyPlaceholders, matchesExclusionFilter, isPrivateVideo } from '../../postUtils.js';

export const checkEpisodes = new Hono();

// ---------------------------------------------------------------------------
// Redis key constants
// ---------------------------------------------------------------------------

const REDIS_KEY_GOOGLE_API_KEY = 'google_api_key';
const REDIS_KEY_PENDING_POST = 'pending_post';
const REDIS_KEY_PENDING_POST_JOB_ID = 'pending_post_job_id';
const REDIS_KEY_GEMINI_MODEL = 'gemini_model';
const REDIS_KEY_THINKING_LEVEL = 'gemini_thinking_level';

interface PendingPost {
  title: string;
  body: string;
  url: string;
  videoId: string;
  videoTitle: string;
  generatedAt: string;
}

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
// Gemini model + thinking level — advanced, optional overrides chosen in
// "Configure bot" and stored in Redis. Unset means DEFAULT_GEMINI_MODEL with
// no reasoning_effort (the model decides how much to think).
// ---------------------------------------------------------------------------

async function getGeminiChoice(): Promise<{ model: string; thinkingLevel: ThinkingLevel | undefined }> {
  const [storedModel, storedLevel] = await Promise.all([
    redis.get(REDIS_KEY_GEMINI_MODEL),
    redis.get(REDIS_KEY_THINKING_LEVEL),
  ]);
  const model = storedModel || DEFAULT_GEMINI_MODEL;
  return { model, thinkingLevel: resolveThinkingLevel(model, storedLevel) };
}

checkEpisodes.post('/check-new-episodes', async (c) => {
  const event = await c.req.json<TaskRequest<{ manual?: boolean; forceRepost?: boolean }>>();
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
      getGeminiChoice(),
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
      return c.json<TaskResponse>({}, 200);
    }
    if (!playlistId) {
      await notConfigured('No YouTube Playlist ID is set. Add it in the app settings (Mod Tools → Installed Apps).');
      return c.json<TaskResponse>({}, 200);
    }
    if (!systemPrompt) {
      await notConfigured('No System Prompt is set. Add it in the app settings (Mod Tools → Installed Apps).');
      return c.json<TaskResponse>({}, 200);
    }

    // 3. Fetch playlist videos (newest first, full list) and every registry
    //    entry in parallel — these are independent reads, and resolving them
    //    concurrently (rather than one giant hGet-per-video loop below) keeps
    //    the job well clear of Devvit's per-invocation execution timeout as
    //    the playlist grows.
    const subredditName = context.subredditName;
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
      return c.json<TaskResponse>({}, 200);
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
      return c.json<TaskResponse>({}, 200);
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
      return c.json<TaskResponse>({}, 200);
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
        const jobId = await scheduler.runJob({
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

      return c.json<TaskResponse>({}, 200);
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
      `The video check on r/${context.subredditName} failed with the following error:\n\n    ${err}\n\n${FAILURE_HELP}`,
    );
  }

  return c.json<TaskResponse>({}, 200);
});
