import type { AIServiceConfig, AIProviderConfig } from './types.js';

const DEFAULT_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

const DEFAULT_GEMINI_RATE_LIMIT = 1000;
const DEFAULT_GROQ_RATE_LIMIT = 1000;

/**
 * Loads AI provider configuration from env vars.
 *
 * `AI_GEMINI_MODELS` is a comma-separated, ordered list of Gemini models to
 * register. The first one is tried first; on rate limit or failure, the
 * service falls back to the next. Each model gets its own rate limiter.
 *
 * Example:
 *   AI_GEMINI_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite"
 *
 * Falls back to a sensible default chain if not set.
 */
export function loadAIConfig(): AIServiceConfig {
  const fallbackEnabled = process.env.AI_FALLBACK_ENABLED !== 'false';

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  const geminiRateLimit = parseInt(process.env.AI_GEMINI_RATE_LIMIT || '', 10) || DEFAULT_GEMINI_RATE_LIMIT;
  const groqRateLimit = parseInt(process.env.AI_GROQ_RATE_LIMIT || '', 10) || DEFAULT_GROQ_RATE_LIMIT;

  const providers: AIProviderConfig[] = [];

  if (geminiApiKey) {
    const modelList = (process.env.AI_GEMINI_MODELS || DEFAULT_GEMINI_MODELS.join(','))
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    for (const model of modelList) {
      providers.push({
        name: `gemini:${model}`,
        kind: 'gemini',
        apiKey: geminiApiKey,
        model,
        rateLimit: geminiRateLimit,
      });
    }
  }

  if (groqApiKey) {
    const groqModel = process.env.AI_GROQ_MODEL || DEFAULT_GROQ_MODEL;
    providers.push({
      name: `groq:${groqModel}`,
      kind: 'groq',
      apiKey: groqApiKey,
      model: groqModel,
      rateLimit: groqRateLimit,
    });
  }

  return {
    fallbackEnabled,
    providers,
  };
}
