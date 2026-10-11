# Link post with a stickied discussion comment

Episode posts are Reddit link posts pointing at the video, with the generated discussion text in a distinguished, stickied top comment, because Reddit cannot carry both a `url` and a text body on one post and only link posts get the native video thumbnail/preview card. Regenerating an episode therefore edits the comment, not the post.

## Considered Options

- **Self post with a markdown video link** (previous behavior): keeps the text on the post, but there's no preview card; mods found this made posts feel useless.
- **Self post with a richtext `embed` node**: live-tested; Reddit silently strips the embed and the post body comes back empty.
- **Self post with a bare video URL line**: live-tested; renders as a plain link, no auto-embed card.
- **Link post with `text` also set**: rejected by Reddit's submit API and hard-typed as impossible in `@devvit/reddit` (`text?: never` on link posts).

## Consequences

- Posts created before this change have no tracked discussion comment and cannot be regenerated.
- The `videoLinkLabel` setting was removed; the video link is the post itself.
