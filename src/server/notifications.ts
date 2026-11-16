/**
 * Failure notifications mods need to act on. `sendFailureNotification` PMs
 * configured notificationMods or the triggering mod; the pending publisher
 * uses the moderator-inbox fallback when an unattended auto-approval has no
 * PM recipient. Notification failures never mask the original error.
 */

// Minimal, structurally-typed slice of the Reddit client this module calls —
// the same seam postManager.ts and checkerSchedule.ts use.
type RedditClient = {
  sendPrivateMessage: (message: { to: string; subject: string; text: string }) => Promise<unknown>;
};

type ModInboxRedditClient = {
  getSubredditByName: (subredditName: string) => Promise<{ id: `t5_${string}` }>;
  modMail: {
    createModInboxConversation: (message: {
      subredditId: `t5_${string}`;
      subject: string;
      bodyMarkdown: string;
    }) => Promise<unknown>;
  };
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

/**
 * Report an unattended failure to the moderator inbox. PM delivery has no
 * recipient when notificationMods and a manual triggering moderator are absent.
 */
export async function sendModInboxFailureNotification(
  reddit: ModInboxRedditClient,
  subredditName: string,
  subject: string,
  text: string,
): Promise<void> {
  try {
    const subreddit = await reddit.getSubredditByName(subredditName);
    await reddit.modMail.createModInboxConversation({
      subredditId: subreddit.id,
      subject,
      bodyMarkdown: text,
    });
    console.log('[bot] Sent failure notification to the moderator inbox.');
  } catch (mailErr) {
    console.error(`[bot] Failed to send failure notification to the moderator inbox: ${mailErr}`);
  }
}
