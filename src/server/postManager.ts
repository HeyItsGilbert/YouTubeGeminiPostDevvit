// A minimal, structurally-typed slice of the Reddit/Redis clients this module
// actually calls — declared locally rather than imported from the Devvit SDK,
// the same seam checkerSchedule.ts and videoRegistry.ts use. The real
// `@devvit/reddit`/`@devvit/redis` singleton clients satisfy this shape
// structurally, so no adapter is needed at the call site.

/** Reddit "thing" ID prefixes this module handles — kept local rather than
 * importing `T1`/`T3` from the Devvit SDK. */
type PostId = `t3_${string}`;
type CommentId = `t1_${string}`;

type RedditClient = {
  submitPost(options: { title: string; subredditName: string; url: string }): Promise<{ id: PostId }>;
  getAppUser(): Promise<{ username: string } | undefined>;
  getNewPosts(options: { subredditName: string; limit: number }): {
    get(count: number): Promise<Array<{
      id: PostId;
      authorName: string;
      createdAt: Date;
      title: string;
      url: string;
    }>>;
  };
  setUserFlair(options: { subredditName: string; username: string; text: string }): Promise<unknown>;
  getCommentById(id: CommentId): Promise<{
    edit(options: { text: string }): Promise<unknown>;
    distinguish(sticky?: boolean): Promise<unknown>;
  }>;
  getPostFlairTemplates(subredditName: string): Promise<Array<{ id: string; text?: string }>>;
  setPostFlair(options: { subredditName: string; postId: PostId; flairTemplateId: string }): Promise<unknown>;
  getPostById(id: PostId): Promise<RedditPost>;
};

type RedditPost = {
  addComment(options: { text: string }): Promise<{ id?: CommentId } | undefined>;
  sticky(position: 1 | 2): Promise<unknown>;
  comments: {
    get(count: number): Promise<Array<{ id: CommentId; authorName: string; body: string }>>;
  };
};

type RedisClient = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<unknown>;
};

/** IDs of the post and its discussion comment created by createEpisodePost. */
export interface EpisodePost {
  postId: PostId;
  commentId: CommentId;
}

// ----- Post creation --------------------------------------------------------

const RECONCILIATION_SEARCH_LIMIT = 100;

/** Submit the immutable Reddit link post and return its accepted ID. */
export async function createEpisodeLinkPost(
  reddit: RedditClient,
  subredditName: string,
  title: string,
  url: string,
): Promise<PostId> {
  const post = await reddit.submitPost({ title, subredditName, url });
  return post.id;
}

/** Fetch the Episode Post before recording a discussion-comment submission intent. */
export async function getEpisodePost(reddit: RedditClient, postId: PostId): Promise<RedditPost> {
  return reddit.getPostById(postId);
}

/** Submit a generated discussion comment to an already-fetched Episode Post. */
export async function submitEpisodeDiscussionComment(post: RedditPost, body: string): Promise<CommentId | null> {
  const comment = await post.addComment({ text: body });
  return comment?.id ?? null;
}

/** Add the generated discussion as a top-level comment and return its accepted ID. */
export async function createEpisodeDiscussionComment(
  reddit: RedditClient,
  postId: PostId,
  body: string,
): Promise<CommentId> {
  const commentId = await submitEpisodeDiscussionComment(await getEpisodePost(reddit, postId), body);
  if (!commentId) throw new Error('Reddit did not accept the discussion comment.');
  return commentId;
}

/** Distinguish and sticky the persisted Discussion Comment. */
export async function distinguishEpisodeDiscussionComment(
  reddit: RedditClient,
  commentId: CommentId,
): Promise<void> {
  const comment = await reddit.getCommentById(commentId);
  await comment.distinguish(true);
}

/** Locate a uniquely matching accepted link post without submitting another. */
export async function findEpisodeLinkPost(
  reddit: RedditClient,
  subredditName: string,
  title: string,
  url: string,
  generatedAt: string,
): Promise<PostId | null> {
  const generatedAtMs = Date.parse(generatedAt);
  if (Number.isNaN(generatedAtMs)) return null;
  const appUser = await reddit.getAppUser();
  if (!appUser) return null;
  const posts = await reddit.getNewPosts({ subredditName, limit: RECONCILIATION_SEARCH_LIMIT })
    .get(RECONCILIATION_SEARCH_LIMIT);
  const matches = posts.filter((post) => (
    post.authorName === appUser.username
    && post.title === title
    && post.url === url
    && post.createdAt.getTime() >= generatedAtMs
  ));
  return matches.length === 1 ? matches[0]!.id : null;
}

/** Locate a uniquely matching accepted Discussion Comment without adding another. */
export async function findEpisodeDiscussionComment(
  reddit: RedditClient,
  postId: PostId,
  body: string,
): Promise<CommentId | null> {
  const appUser = await reddit.getAppUser();
  if (!appUser) return null;
  const post = await reddit.getPostById(postId);
  const comments = await post.comments.get(RECONCILIATION_SEARCH_LIMIT);
  const matches = comments.filter((comment) => (
    comment.authorName === appUser.username && comment.body === body
  ));
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * Submit a link post pointing at the YouTube video and create its distinguished,
 * stickied Discussion Comment. Immediate publication has no durable state between
 * these operations; Pending Posts call the individual helpers to persist IDs.
 */
export async function createEpisodePost(
  reddit: RedditClient,
  subredditName: string,
  title: string,
  url: string,
  body: string,
): Promise<EpisodePost> {
  const postId = await createEpisodeLinkPost(reddit, subredditName, title, url);
  const commentId = await createEpisodeDiscussionComment(reddit, postId, body);
  await distinguishEpisodeDiscussionComment(reddit, commentId);
  return { postId, commentId };
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
    if (!botUser) {
      console.error('[postManager] Failed to set bot flair: no app user found');
      return;
    }
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
  newPostId: PostId
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
