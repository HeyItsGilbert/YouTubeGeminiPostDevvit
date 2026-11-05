import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { checkEpisodes } from './routes/check-episodes.js';
import { pendingPost } from './routes/pending-post.js';
import { regenerate } from './routes/regenerate.js';
import { triggers } from './routes/triggers.js';

const app = new Hono();
const internal = new Hono();

internal.route('/scheduler', checkEpisodes);
internal.route('/scheduler', pendingPost);
internal.route('/scheduler', regenerate);
internal.route('/triggers', triggers);

app.route('/internal', internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
