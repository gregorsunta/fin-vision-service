import type { AIServiceConfig, AIProviderName } from './types.js';

const DEFAULT_GEMINI_RATE_LIMIT = 20;
const DEFAULT_GROQ_RATE_LIMIT = 1000;

export function loadAIConfig(): AIServiceConfig {
  const primaryProvider = (process.env.AI_PRIMARY_PROVIDER || 'groq') as AIProviderName;
  const fallbackEnabled = process.env.AI_FALLBACK_ENABLED !== 'false';

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  const geminiRateLimit = parseInt(process.env.AI_GEMINI_RATE_LIMIT || '', 10) || DEFAULT_GEMINI_RATE_LIMIT;
  const groqRateLimit = parseInt(process.env.AI_GROQ_RATE_LIMIT || '', 10) || DEFAULT_GROQ_RATE_LIMIT;

  const config: AIServiceConfig = {
    primaryProvider,
    fallbackEnabled,
    providers: {},
  };

  if (geminiApiKey) {
    config.providers.gemini = {
      apiKey: geminiApiKey,
      model: process.env.AI_GEMINI_MODEL || 'gemini-2.5-flash',
      rateLimit: geminiRateLimit,
    };
  }

  if (groqApiKey) {
    config.providers.groq = {
      apiKey: groqApiKey,
      model: process.env.AI_GROQ_MODEL || 'llama-3.3-70b-versatile',
      rateLimit: groqRateLimit,
    };
  }

  return config;
}
