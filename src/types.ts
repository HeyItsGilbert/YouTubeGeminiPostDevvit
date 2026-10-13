/**
 * Shared types for the YouTube + Gemini auto-post bot.
 */

export interface EpisodeData {
  /** Unique identifier (YouTube video ID) — used for deduplication */
  guid: string;
  /** Video title as-is from YouTube */
  title: string;
  /** Video description from YouTube */
  description: string;
  /** ISO 8601 publish date string from YouTube */
  pubDate: string;
  /** Video URL */
  link: string;
  /** Episode number, if present */
  episodeNumber?: string;
}

export interface GeneratedPost {
  /** Post title (first line of Gemini output) */
  title: string;
  /** Markdown body for the Reddit post */
  body: string;
}

/** Registry entry stored in Redis hash `video_registry` keyed by video ID */
export interface VideoRecord {
  /** Video title at the time of processing */
  title: string;
  /** Outcome of processing this video */
  status: 'posted' | 'pending' | 'excluded' | 'rejected' | 'skipped' | 'private';
  /** Reddit post ID — only set when status is 'posted' */
  postId?: string;
  /** Reddit comment ID holding the generated discussion body — only set when status is 'posted' */
  commentId?: string;
  /** ISO 8601 timestamp when the record was written */
  processedAt: string;
}

/** `reasoning_effort` values on Gemini's OpenAI-compatible endpoint, least to most thinking. */
export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface GeminiModel {
  /** Model ID passed to the API, e.g. `gemini-3-flash-preview` */
  id: string;
  /** Display name from the models API */
  name: string;
  /** Levels the model accepted when probed, least to most; empty = no level control */
  thinkingLevels: ThinkingLevel[];
}

/** Build-time snapshot written by `npm run models:sync` */
export interface GeminiModelCatalog {
  /** ISO 8601 time the catalog was fetched */
  fetchedAt: string;
  models: GeminiModel[];
}
