import { Devvit } from '@devvit/public-api';

// ----- Types ----------------------------------------------------------------

type RedditClient = Devvit.Context['reddit'];
type RedisClient = Devvit.Context['redis'];
type PostId = Parameters<RedditClient['setPostFlair']>[0]['postId'];
type CommentId = Parameters<RedditClient['getCommentById']>[0];

/** IDs of the post and its discussion comment created by createEpisodePost. */
export interface EpisodePost {
  postId: PostId;
  commentId: CommentId;
}

// ----- Post creation --------------------------------------------------------

/**
 * Submit a link post pointing at the YouTube video — this gets Reddit's
 * native thumbnail/preview card, which a self post cannot. Reddit's post
 * model is mutually exclusive between `url` (link posts) and `text`/
 * `richtext` (self posts), so the generated discussion body is posted
 * separately as a distinguished, stickied top-level comment.
 */
export async function createEpisodePost(
  reddit: RedditClient,
  subredditName: string,
  title: string,
  url: string,
  body: string
): Promise<EpisodePost> {
  const post = await reddit.submitPost({
    title,
    subredditName,
    url,
  });
  const comment = await post.addComment({ text: body });
  await comment.distinguish(true);
  return { postId: post.id, commentId: comment.id };
}

// ----- Bot identity ---------------------------------------------------------

/**
 * Set the bot's author flair on the subreddit so each community can give it
 * a unique display name and emoji icon.
 */
export async function applyBotFlair(
  reddit: RedditClient,
  subredditName: string,
  emoji: string,
  text: string
): Promise<void> {
  const flairText = [emoji, text].filter(Boolean).join(' ');
  if (!flairText) return;

  try {
    const botUser = await reddit.getAppUser();
    await reddit.setUserFlair({
      subredditName,
      username: botUser.username,
      text: flairText,
    });
    console.log(`[postManager] Set bot flair to "${flairText}" for u/${botUser.username}`);
  } catch (err) {
    console.error(`[postManager] Failed to set bot flair: ${err}`);
  }
}

// ----- Comment editing -------------------------------------------------------

/**
 * Edit the text of the discussion comment under an existing episode post.
 * The post itself is a link post and has no editable body text — the
 * generated discussion lives entirely in the stickied comment.
 */
export async function updateEpisodePost(
  reddit: RedditClient,
  commentId: CommentId,
  body: string
): Promise<void> {
  const comment = await reddit.getCommentById(commentId);
  await comment.edit({ text: body });
}

// ----- Flair ----------------------------------------------------------------

/**
 * Apply a flair to a post by matching the flair template name.
 * If flairName is empty or not found, the post remains unflaired.
 */
export async function applyFlair(
  reddit: RedditClient,
  subredditName: string,
  postId: PostId,
  flairName: string
): Promise<void> {
  if (!flairName) return;

  try {
    const flairs = await reddit.getPostFlairTemplates(subredditName);
    const match = flairs.find(
      (f) => (f.text ?? '').toLowerCase().trim() === flairName.toLowerCase().trim()
    );

    if (!match) {
      console.error(
        `[postManager] Flair "${flairName}" not found on subreddit. ` +
        'Post will remain unflaired.'
      );
      return;
    }

    await reddit.setPostFlair({
      subredditName,
      postId,
      flairTemplateId: match.id,
    });

    console.log(`[postManager] Applied flair "${match.text}" to ${postId}`);
  } catch (err) {
    console.error(`[postManager] Failed to apply flair: ${err}`);
  }
}

// ----- Pin management -------------------------------------------------------

/**
 * Pin the new post, replacing the bot's previous sticky slot in-place.
 *
 * Calls sticky(slot) on the new post — Reddit atomically displaces whatever
 * is already in that slot, so no explicit unsticky() is needed. This ensures
 * the bot never removes more than its own tracked slot.
 *
 * The slot used is persisted in Redis under `last_episode_sticky_slot` so
 * future runs replace the same slot. Defaults to slot 1 on first run.
 */
export async function managePins(
  reddit: RedditClient,
  redis: RedisClient,
  newPostId: string
): Promise<void> {
  // Determine which slot the bot last used (default: 1)
  const slotStr = await redis.get('last_episode_sticky_slot');
  const slotNum = parseInt(slotStr ?? '1', 10);
  const slot = ([1, 2].includes(slotNum) ? slotNum : 1) as 1 | 2;

  // Sticky the new post into the same slot — Reddit replaces whatever was there
  try {
    const newPost = await reddit.getPostById(newPostId);
    await newPost.sticky(slot);
    console.log(`[postManager] Pinned new post ${newPostId} to slot ${slot}`);
  } catch (err) {
    console.error(`[postManager] Failed to pin new post ${newPostId}: ${err}`);
    throw err; // rethrow — caller should know pinning failed
  }

  // Persist the slot for the next run
  await redis.set('last_episode_sticky_slot', String(slot));
}
