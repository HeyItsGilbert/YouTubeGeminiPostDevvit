import { type EpisodeData, type GeneratedPost } from './types.js';

// Uses the OpenAI-compatible endpoint to avoid colon-in-path URLs like
// `:generateContent`, which Devvit's HTTP proxy misinterprets as gRPC routing.
const GEMINI_OPENAI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

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
  const userMessage = buildUserMessage(episode);

  console.log(`[llmClient] POST ${GEMINI_OPENAI_URL} (model: ${geminiModel})`);
  console.log(`[llmClient] System prompt: ${systemPrompt.length} chars, user message: ${userMessage.length} chars`);

  const response = await fetch(GEMINI_OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: geminiModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 4096,
    }),
  });

  console.log(`[llmClient] Response status: ${response.status}`);

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

/**
 * Split the generated response into a Reddit title and body.
 *
 * Convention: the first non-empty line of the Gemini output is used as the
 * post title. Everything after it becomes the body. The system prompt
 * supplied by the mod controls what format the title takes.
 */
function parseGeneratedResponse(fullText: string, fallbackTitle: string): GeneratedPost {
  const lines = fullText.split('\n');

  // Find the first non-empty line — that's the title
  const titleLineIndex = lines.findIndex((l) => l.trim().length > 0);
  if (titleLineIndex === -1) {
    return {
      title: fallbackTitle,
      body: fullText.trim(),
    };
  }

  const title = lines[titleLineIndex].trim();

  // Everything after the title line is the body
  const body = lines
    .slice(titleLineIndex + 1)
    .join('\n')
    .trim();

  return { title, body };
}

/**
 * Build the user message containing video metadata.
 */
function buildUserMessage(episode: EpisodeData): string {
  const parts: string[] = [
    'New video released. Please generate the full post following your instructions.',
    '',
    `**Title:** ${episode.title}`,
  ];

  if (episode.episodeNumber) {
    parts.push(`**Episode Number:** ${episode.episodeNumber}`);
  }

  parts.push(`**Published:** ${episode.pubDate}`);

  if (episode.link) {
    parts.push(`**Link:** ${episode.link}`);
  }

  parts.push('', '**Description:**', episode.description || '(No description available)');

  return parts.join('\n');
}
