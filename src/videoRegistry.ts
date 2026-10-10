import { type VideoRecord } from './types.js';

/** Redis hash key — each field is a video ID, each value is a JSON VideoRecord */
export const REGISTRY_KEY = 'video_registry';

type RedisClient = {
  hGetAll: (key: string) => Promise<Record<string, string>>;
  hSet: (key: string, value: Record<string, string>) => Promise<number>;
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
 * Write (or overwrite) a registry entry for a video.
 */
export async function setVideoRecord(
  redis: RedisClient,
  videoId: string,
  record: VideoRecord
): Promise<void> {
  await redis.hSet(REGISTRY_KEY, { [videoId]: JSON.stringify(record) });
}
