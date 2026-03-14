import { type VideoRecord } from './types.js';

/** Redis hash key — each field is a video ID, each value is a JSON VideoRecord */
export const REGISTRY_KEY = 'video_registry';

type RedisClient = {
  hGet: (key: string, field: string) => Promise<string | undefined | null>;
  hSet: (key: string, value: Record<string, string>) => Promise<number>;
};

/**
 * Retrieve the registry entry for a video, or null if it has never been seen.
 */
export async function getVideoRecord(
  redis: RedisClient,
  videoId: string
): Promise<VideoRecord | null> {
  const raw = await redis.hGet(REGISTRY_KEY, videoId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VideoRecord;
  } catch {
    return null;
  }
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
