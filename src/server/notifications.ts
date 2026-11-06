/**
 * PM notifications for failures mods need to act on. Shared by
 * `check-episodes.ts` and the `post_pending_episode` job — both need to
 * report a failure to the configured `notificationMods`, falling back to
 * whichever mod manually triggered the action, without throwing (a failed
 * notification should never mask the original error).
 */

// Minimal, structurally-typed slice of the Reddit client this module calls —
// the same seam postManager.ts and checkerSchedule.ts use.
type RedditClient = {
  sendPrivateMessage: (message: { to: string; subject: string; text: string }) => Promise<unknown>;
};

/** Closing line of failure PMs: things a mod can act on (they can't read app logs). */
export const FAILURE_HELP =
  'Please try again later. If it keeps failing, check the Google API key in "Configure bot" (in the subreddit\'s "…" menu) and the app settings in Mod Tools → Installed Apps, or report it at https://github.com/HeyItsGilbert/YouTubeGeminiPostDevvit/issues.';

/**
 * Send a PM (usually a failure report) to the appropriate recipients.
 *
 * Priority: if notificationMods are configured, PM each of them.
 * Otherwise fall back to the individual mod who triggered the action
 * (fallbackRecipient). If neither is available, only log — never throws.
 */
export async function sendFailureNotification(
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
