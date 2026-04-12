import type { AIProvider, AIProviderConfig, AIProviderKind } from '../types.js';
import { GeminiProvider } from './gemini-provider.js';
import { GroqProvider } from './groq-provider.js';

/**
 * Provider factory abstraction. Each entry in the registry knows how to:
 *   1. Construct a provider instance from a config
 *   2. Detect provider-specific rate-limit (HTTP 429) errors
 *
 * To add a new LLM provider:
 *   1. Create `src/ai/providers/<name>-provider.ts` exporting a class that
 *      implements `AIProvider` and a `static detectRateLimit(error)` method.
 *   2. Add the kind to `AIProviderKind` in `src/ai/types.ts`.
 *   3. Add an entry to `providerRegistry` below.
 *   4. Wire env-driven config in `src/ai/config.ts`.
 *
 * AIService is otherwise provider-agnostic — no if/else chains to update.
 */
export interface ProviderFactory {
  create(config: AIProviderConfig): AIProvider;
  detectRateLimit(error: unknown): { is429: boolean; retryAfterMs?: number };
}

export const providerRegistry: Record<AIProviderKind, ProviderFactory> = {
  gemini: {
    create: (config) => new GeminiProvider(config),
    detectRateLimit: GeminiProvider.detectRateLimit,
  },
  groq: {
    create: (config) => new GroqProvider(config),
    detectRateLimit: GroqProvider.detectRateLimit,
  },
};

export function getProviderFactory(kind: AIProviderKind): ProviderFactory | null {
  return providerRegistry[kind] ?? null;
}
