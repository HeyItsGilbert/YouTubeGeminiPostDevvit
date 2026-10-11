import { type EpisodeData, type GeneratedPost } from './types.js';
import { buildUserMessage, parseGeneratedResponse, applyPlaceholders } from './postUtils.js';

// Uses the OpenAI-compatible endpoint to avoid colon-in-path URLs like
// `:generateContent`, which Devvit's HTTP proxy misinterprets as gRPC routing.
const GEMINI_OPENAI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Devvit cuts HTTP requests off at 30 s and can end the whole invocation
// without logging anything. Give up earlier so the error is logged and the
// job's failure handler can notify mods, with headroom for the YouTube calls
// that run before Gemini in the same invocation.
const GEMINI_DEADLINE_MS = 20_000;

// Thinking time is what pushes long system prompts past the deadline.
// 'minimal' is the lowest effort every Gemini thinking family accepts on the
// OpenAI-compatible endpoint (Gemini 3 cannot disable thinking entirely).
const GEMINI_REASONING_EFFORT = 'minimal';

/**
 * Call the Gemini API to generate a post from video metadata.
 * Uses the OpenAI-compatible endpoint so the URL has no colon-prefixed
 * method segment, which is required for Devvit's HTTP proxy.
 */
export async function generateEpisodePost(
  apiKey: string,
  episode: EpisodeData,
  systemPrompt: string,
  geminiModel: string
): Promise<GeneratedPost> {
  const resolvedSystemPrompt = applyPlaceholders(systemPrompt, episode);
  const userMessage = buildUserMessage(episode);

  console.log(`[llmClient] POST ${GEMINI_OPENAI_URL} (model: ${geminiModel})`);
  console.log(`[llmClient] System prompt: ${resolvedSystemPrompt.length} chars, user message: ${userMessage.length} chars`);

  let cancelDeadline = (): void => {};
  const timedOut = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Gemini did not respond within ${GEMINI_DEADLINE_MS / 1000} s (model: ${geminiModel}). Try a shorter system prompt or a faster model.`)),
      GEMINI_DEADLINE_MS,
    );
    cancelDeadline = () => clearTimeout(timer);
  });
  const started = Date.now();
  let response: Response;
  try {
    response = await Promise.race([
      fetch(GEMINI_OPENAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: geminiModel,
          messages: [
            { role: 'system', content: resolvedSystemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 4096,
          reasoning_effort: GEMINI_REASONING_EFFORT,
        }),
      }),
      timedOut,
    ]);
  } catch (err) {
    console.error(`[llmClient] Request failed after ${Date.now() - started} ms: ${err}`);
    throw err;
  } finally {
    cancelDeadline();
  }

  console.log(`[llmClient] Response status: ${response.status} after ${Date.now() - started} ms`);

  if (!response.ok) {
    const errText = await response.text().catch(() => '(unreadable)');
    console.error(`[llmClient] Error response: ${errText.slice(0, 500)}`);
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
  };

  const choice = data.choices?.[0];
  const fullText = choice?.message?.content ?? '';
  const finishReason = choice?.finish_reason ?? 'unknown';

  console.log(`[llmClient] finish_reason: ${finishReason}, response length: ${fullText.length} chars`);
  if (finishReason === 'length') {
    console.warn('[llmClient] Response was cut off by max_tokens limit — consider raising it or shortening the system prompt.');
  }

  if (!fullText) {
    console.error(`[llmClient] Empty response. Raw: ${JSON.stringify(data).slice(0, 500)}`);
    throw new Error('Gemini returned an empty response');
  }

  return parseGeneratedResponse(fullText, episode.title);
}

