import { type EpisodeData } from './types.js';
import { resolvePlaylistId } from './postUtils.js';

const YT_API_BASE = 'https://youtube.googleapis.com/youtube/v3';

interface YouTubePlaylistResponse {
  nextPageToken?: string;
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
 * Fetch all videos from a YouTube playlist, sorted newest-first.
 * Paginates through all pages (50 items each) until the full list is
 * retrieved, then sorts by publishedAt descending.
 *
 * If a channel ID (UC...) is supplied it is silently converted to the
 * corresponding Uploads playlist (UU...) which the API already returns
 * in chronological-descending order, making the sort a no-op.
 *
 * Returns an empty array if the playlist has no videos.
 */
export async function fetchPlaylistVideos(
  apiKey: string,
  playlistId: string
): Promise<EpisodeData[]> {
  const resolvedId = resolvePlaylistId(playlistId);
  if (resolvedId !== playlistId) {
    console.log(`[episodeChecker] Converted channel ID ${playlistId} → uploads playlist ${resolvedId}`);
  }

  const allItems: NonNullable<YouTubePlaylistResponse['items']> = [];
  let pageToken: string | undefined;

  do {
    const url =
      `${YT_API_BASE}/playlistItems` +
      `?part=snippet&maxResults=50&playlistId=${encodeURIComponent(resolvedId)}&key=${encodeURIComponent(apiKey)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

    const response = await fetch(url);
    if (!response.ok) {
      const errText = await response.text().catch(() => '(unreadable)');
      throw new Error(`YouTube API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as YouTubePlaylistResponse;
    if (data.items?.length) {
      allItems.push(...data.items);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  console.log(`[episodeChecker] Fetched ${allItems.length} videos from playlist ${resolvedId}`);

  if (!allItems.length) return [];

  return [...allItems]
    .sort(
      (a, b) =>
        new Date(b.snippet.publishedAt).getTime() -
        new Date(a.snippet.publishedAt).getTime()
    )
    .map((item) => {
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
    });
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

