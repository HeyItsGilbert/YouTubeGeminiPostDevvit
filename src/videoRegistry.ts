import { type VideoRecord } from './types.js';

/** Redis hash key — each field is a video ID, each value is a JSON VideoRecord */
export const REGISTRY_KEY = 'video_registry';

type RedisClient = {
  hGet: (key: string, field: string) => Promise<string | undefined>;
  hGetAll: (key: string) => Promise<Record<string, string>>;
  hSet: (key: string, value: Record<string, string>) => Promise<number>;
  hDel: (key: string, fields: string[]) => Promise<number>;
};

/**
 * Retrieve every registry entry in a single round trip. A per-video hGet
 * loop does one Redis round trip per video, and its latency grows linearly
 * with playlist length — that adds up toward Devvit's per-invocation
 * execution timeout as the playlist keeps growing. A single hGetAll() call
 * parses the whole hash once regardless of how many videos are checked.
 */
export async function getAllVideoRecords(
  redis: RedisClient
): Promise<Record<string, VideoRecord>> {
  const raw = await redis.hGetAll(REGISTRY_KEY);
  const records: Record<string, VideoRecord> = {};
  for (const [videoId, json] of Object.entries(raw)) {
    try {
      records[videoId] = JSON.parse(json) as VideoRecord;
    } catch {
      // Skip corrupt entries — treated as "never seen" by callers.
    }
  }
  return records;
}

/**
 * Find the video whose Episode Post has the given Reddit post ID.
 */
export async function findVideoByPostId(
  redis: RedisClient,
  postId: string
): Promise<{ videoId: string; record: VideoRecord } | null> {
  const records = await getAllVideoRecords(redis);
  for (const [videoId, record] of Object.entries(records)) {
    if (record.postId === postId) {
      return { videoId, record };
    }
  }
  return null;
}

async function isPosted(redis: RedisClient, videoId: string): Promise<boolean> {
  const json = await redis.hGet(REGISTRY_KEY, videoId);
  if (!json) return false;
  try {
    return (JSON.parse(json) as VideoRecord).status === 'posted';
  } catch {
    return false;
  }
}

/**
 * Write (or overwrite) a registry entry for a video.
 *
 * `posted` is terminal: a posted video's record can only be replaced by
 * another `posted` record (a forced repost). Any other write is ignored and
 * this returns false.
 */
export async function setVideoRecord(
  redis: RedisClient,
  videoId: string,
  record: VideoRecord
): Promise<boolean> {
  if (record.status !== 'posted' && (await isPosted(redis, videoId))) {
    return false;
  }
  await redis.hSet(REGISTRY_KEY, { [videoId]: JSON.stringify(record) });
  return true;
}

/**
 * Remove a video's registry entry so the next check treats it as unseen.
 * Posted records are never removed; returns false in that case.
 */
export async function deleteVideoRecord(
  redis: RedisClient,
  videoId: string
): Promise<boolean> {
  if (await isPosted(redis, videoId)) {
    return false;
  }
  await redis.hDel(REGISTRY_KEY, [videoId]);
  return true;
}
