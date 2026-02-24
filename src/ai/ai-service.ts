import { GoogleGenerativeAIFetchError } from '@google/generative-ai';
import { RateLimitError as GroqRateLimitError } from 'groq-sdk';
import type { AIProvider, AIProviderName, AIGenerateOptions, AIGenerateResult, AIServiceConfig } from './types.js';
import { AIRateLimitExceededError, AIProviderUnavailableError, AIGenerationError } from './errors.js';
import { getRateLimiter, RateLimiter } from './rate-limiter.js';
import { GeminiProvider, GroqProvider } from './providers/index.js';

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function isRateLimitError(error: unknown): { is429: true; retryAfterMs?: number } | { is429: false } {
  if (error instanceof GroqRateLimitError) {
    const retryAfter = error.headers?.['retry-after'];
    const retryAfterMs = retryAfter ? parseFloat(retryAfter) * 1000 : undefined;
    return { is429: true, retryAfterMs };
  }

  if (error instanceof GoogleGenerativeAIFetchError && error.status === 429) {
    return { is429: true };
  }

  return { is429: false };
}

export class AIService {
  private providers: Map<AIProviderName, AIProvider> = new Map();
  private rateLimiter: RateLimiter;
  private primaryProvider: AIProviderName;
  private fallbackEnabled: boolean;

  constructor(config: AIServiceConfig) {
    this.rateLimiter = getRateLimiter();
    this.primaryProvider = config.primaryProvider;
    this.fallbackEnabled = config.fallbackEnabled;

    if (config.providers.gemini) {
      const geminiProvider = new GeminiProvider(config.providers.gemini);
      this.providers.set('gemini', geminiProvider);
      this.rateLimiter.configure(
        'gemini',
        config.providers.gemini.rateLimit || 20,
        RATE_LIMIT_WINDOW_MS
      );
      console.log(`[AIService] Gemini provider configured with ${config.providers.gemini.rateLimit || 20} requests/day limit`);
    }

    if (config.providers.groq) {
      const groqProvider = new GroqProvider(config.providers.groq);
      this.providers.set('groq', groqProvider);
      this.rateLimiter.configure(
        'groq',
        config.providers.groq.rateLimit || 1000,
        RATE_LIMIT_WINDOW_MS
      );
      console.log(`[AIService] Groq provider configured with ${config.providers.groq.rateLimit || 1000} requests/day limit`);
    }

    if (this.providers.size === 0) {
      throw new Error('At least one AI provider must be configured');
    }
  }

  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const requireVision = options.requireVision ?? Boolean(options.images && options.images.length > 0);

    const eligibleProviders = this.getEligibleProviders(requireVision);

    if (eligibleProviders.length === 0) {
      throw new AIProviderUnavailableError(
        requireVision ? ['vision', 'textGeneration'] : ['textGeneration'],
        []
      );
    }

    const orderedProviders = this.orderProviders(eligibleProviders);
    const attemptedProviders: AIProviderName[] = [];

    for (const providerName of orderedProviders) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      attemptedProviders.push(providerName);

      if (!this.rateLimiter.canMakeRequest(providerName)) {
        const remaining = this.rateLimiter.getRemainingRequests(providerName);
        const resetTime = this.rateLimiter.getResetTime(providerName);
        console.log(`[AIService] ${providerName} rate limited (${remaining} remaining, resets at ${resetTime.toISOString()})`);

        if (this.fallbackEnabled && orderedProviders.length > 1) {
          continue;
        }

        throw new AIRateLimitExceededError(providerName, remaining, resetTime);
      }

      try {
        console.log(`[AIService] Using ${providerName} provider`);
        const result = await provider.generate(options);
        this.rateLimiter.recordRequest(providerName);
        return result;
      } catch (error) {
        const rateLimitCheck = isRateLimitError(error);
        const isLastProvider = orderedProviders.indexOf(providerName) >= orderedProviders.length - 1;

        if (rateLimitCheck.is429) {
          // Real 429 from the provider - mark exhausted so we don't retry
          this.rateLimiter.markExhausted(providerName, rateLimitCheck.retryAfterMs);
          console.warn(`[AIService] ${providerName} returned 429 (rate limited)`);

          if (this.fallbackEnabled && !isLastProvider) {
            console.log(`[AIService] Falling back to next provider...`);
            continue;
          }

          throw new AIRateLimitExceededError(
            providerName,
            0,
            this.rateLimiter.getResetTime(providerName)
          );
        }

        console.error(`[AIService] ${providerName} generation failed:`, error);

        if (this.fallbackEnabled && !isLastProvider) {
          console.log(`[AIService] Falling back to next provider...`);
          continue;
        }

        throw new AIGenerationError(providerName, error as Error);
      }
    }

    throw new AIProviderUnavailableError(
      requireVision ? ['vision'] : ['textGeneration'],
      attemptedProviders
    );
  }

  private getEligibleProviders(requireVision: boolean): AIProviderName[] {
    const eligible: AIProviderName[] = [];

    for (const [name, provider] of this.providers) {
      if (requireVision && !provider.capabilities.vision) {
        continue;
      }
      if (!provider.capabilities.textGeneration) {
        continue;
      }
      eligible.push(name);
    }

    return eligible;
  }

  private orderProviders(providers: AIProviderName[]): AIProviderName[] {
    const ordered = [...providers];

    ordered.sort((a, b) => {
      if (a === this.primaryProvider) return -1;
      if (b === this.primaryProvider) return 1;
      return 0;
    });

    return ordered;
  }

  getRemainingRequests(provider: AIProviderName): number {
    return this.rateLimiter.getRemainingRequests(provider);
  }

  getProviderStatus(): Record<AIProviderName, { available: boolean; remaining: number; resetTime: Date }> {
    const status: Record<string, { available: boolean; remaining: number; resetTime: Date }> = {};

    for (const [name] of this.providers) {
      const remaining = this.rateLimiter.getRemainingRequests(name);
      const resetTime = this.rateLimiter.getResetTime(name);
      status[name] = {
        available: remaining > 0,
        remaining,
        resetTime,
      };
    }

    return status as Record<AIProviderName, { available: boolean; remaining: number; resetTime: Date }>;
  }
}
