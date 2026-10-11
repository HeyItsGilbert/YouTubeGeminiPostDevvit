# YouTube Gemini Post

Turns new videos from a subreddit's monitored YouTube playlist into Reddit discussion posts written by Gemini, and keeps the latest one pinned.

## Source

**Playlist**:
The single YouTube playlist a subreddit monitors; a channel stands in for its uploads playlist.
_Avoid_: Feed, channel (when the playlist is meant)

**Video**:
One item in the Playlist, identified by its YouTube video ID.
_Avoid_: Episode, upload, item

**Private Video**:
A Video YouTube currently hides behind its "Private video" placeholder; it may become public later.
_Avoid_: Deleted video, hidden video

**Exclusion Keyword**:
A mod-supplied word that marks any Video whose title contains it as never to be posted.
_Avoid_: Filter, blocklist term

## Publishing

**Pending Post**:
A generated title and discussion body for one Video, held for mod approval before it becomes an Episode Post. At most one exists at a time.
_Avoid_: Draft, pending episode, queued post

**Episode Post**:
The Reddit link post pointing at a Video, carrying the generated title.
_Avoid_: Self post, video post

**Discussion Comment**:
The distinguished, stickied top-level comment on an Episode Post that carries the generated discussion body.
_Avoid_: Post body, description

**Regenerate**:
Rewrite the Discussion Comment of the most recent Episode Post with fresh Gemini output; the Episode Post itself is unchanged.
_Avoid_: Repost, refresh

**Pin Slot**:
Which of the subreddit's two sticky positions the latest Episode Post occupies.
_Avoid_: Sticky position, pin rotation

## Video Registry

**Video Registry**:
The record of every Video the app has seen and what became of it.
_Avoid_: Seen list, history

**Posted**:
A Video that has an Episode Post. Terminal: a Posted Video is never posted again, even if it goes private and returns.

**Pending**:
A Video whose Pending Post is awaiting mod approval.

**Excluded**:
A Video whose title matched an Exclusion Keyword. Decided automatically.

**Rejected**:
A Video a mod decided must never be posted. Decided by a mod, unlike Excluded.
_Avoid_: Cancelled

**Skipped**:
A Video older than the one chosen in the same run, left unposted so only the newest Video is announced.
_Avoid_: Ignored, backlog

**Private**:
A Video seen only as a Private Video; it is treated as new once it becomes public.

**Discard**:
Throw away a Pending Post without deciding the Video's fate; the next run treats the Video as unseen.
_Avoid_: Cancel (ambiguous between Discard and Reject)
