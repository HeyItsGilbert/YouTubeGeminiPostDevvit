import { type EpisodeData } from './types.js';

const YT_API_BASE = 'https://youtube.googleapis.com/youtube/v3';

interface YouTubePlaylistResponse {
  items?: Array<{
    snippet: {
      publishedAt: string;
      title: string;
      description: string;
      resourceId: {
        videoId: string;
      };
    };
  }>;
}

/**
 * Fetch the latest video from a YouTube playlist.
 * Returns null if the playlist is empty.
 */
export async function fetchLatestYouTubeEpisode(
  apiKey: string,
  playlistId: string
): Promise<EpisodeData | null> {
  const url =
    `${YT_API_BASE}/playlistItems` +
    `?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const errText = await response.text().catch(() => '(unreadable)');
    throw new Error(`YouTube API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as YouTubePlaylistResponse;
  if (!data.items?.length) return null;

  // Sort descending by publish date so the newest episode is first
  const sorted = [...data.items].sort(
    (a, b) => new Date(b.snippet.publishedAt).getTime() - new Date(a.snippet.publishedAt).getTime()
  );
  const item = sorted[0];

  const { snippet } = item;
  const videoId = snippet.resourceId.videoId;

  return {
    guid: videoId,
    title: snippet.title,
    description: snippet.description ?? '',
    pubDate: snippet.publishedAt,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    episodeNumber: undefined,
  };
}

/**
 * Fetch a specific YouTube video by its ID.
 * Returns null if the video is not found.
 */
export async function fetchYouTubeVideoById(
  apiKey: string,
  videoId: string
): Promise<EpisodeData | null> {
  const url =
    `${YT_API_BASE}/videos` +
    `?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const errText = await response.text().catch(() => '(unreadable)');
    throw new Error(`YouTube API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    items?: Array<{
      snippet: {
        publishedAt: string;
        title: string;
        description: string;
      };
    }>;
  };

  const item = data.items?.[0];
  if (!item) return null;

  const { snippet } = item;
  return {
    guid: videoId,
    title: snippet.title,
    description: snippet.description ?? '',
    pubDate: snippet.publishedAt,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    episodeNumber: undefined,
  };
}

/**
 * Check whether the given episode is newer than the last one we processed.
 * Uses Redis key `last_episode_guid` for comparison.
 */
export async function isNewEpisode(
  redis: { get: (key: string) => Promise<string | undefined | null> },
  episode: EpisodeData
): Promise<boolean> {
  const lastGuid = await redis.get('last_episode_guid');
  return lastGuid !== episode.guid;
}
