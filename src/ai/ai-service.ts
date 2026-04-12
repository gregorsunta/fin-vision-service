import type { AIProvider, AIProviderName, AIGenerateOptions, AIGenerateResult, AIServiceConfig } from './types.js';
import { AIRateLimitExceededError, AIProviderUnavailableError, AIGenerationError } from './errors.js';
import { getRateLimiter, RateLimiter } from './rate-limiter.js';
import { getProviderFactory, type ProviderFactory } from './providers/index.js';

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

interface RegisteredProvider {
  provider: AIProvider;
  factory: ProviderFactory;
}

export class AIService {
  /** Provider instances in fallback priority order (most preferred first). */
  private providers: RegisteredProvider[] = [];
  private rateLimiter: RateLimiter;
  private fallbackEnabled: boolean;

  constructor(config: AIServiceConfig) {
    this.rateLimiter = getRateLimiter();
    this.fallbackEnabled = config.fallbackEnabled;

    for (const providerConfig of config.providers) {
      const factory = getProviderFactory(providerConfig.kind);
      if (!factory) {
        console.warn(`[AIService] Unknown provider kind: ${(providerConfig as any).kind}`);
        continue;
      }

      const provider = factory.create(providerConfig);
      this.providers.push({ provider, factory });
      this.rateLimiter.configure(
        provider.name,
        providerConfig.rateLimit || 1000,
        RATE_LIMIT_WINDOW_MS
      );
      console.log(
        `[AIService] Registered ${provider.name} (rate limit: ${providerConfig.rateLimit || 1000}/day, vision: ${provider.capabilities.vision})`
      );
    }

    if (this.providers.length === 0) {
      throw new Error('At least one AI provider must be configured');
    }
  }

  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const requireVision = options.requireVision ?? Boolean(options.images && options.images.length > 0);
    const requireSpatial = options.requireSpatialReasoning ?? false;

    const eligibleProviders = this.getEligibleProviders(requireVision, requireSpatial);

    if (eligibleProviders.length === 0) {
      const required: string[] = ['textGeneration'];
      if (requireVision) required.push('vision');
      if (requireSpatial) required.push('spatialReasoning');
      throw new AIProviderUnavailableError(required, []);
    }

    const attemptedProviders: AIProviderName[] = [];

    for (let i = 0; i < eligibleProviders.length; i++) {
      const { provider, factory } = eligibleProviders[i];
      const isLastProvider = i === eligibleProviders.length - 1;
      attemptedProviders.push(provider.name);

      if (!this.rateLimiter.canMakeRequest(provider.name)) {
        const remaining = this.rateLimiter.getRemainingRequests(provider.name);
        const resetTime = this.rateLimiter.getResetTime(provider.name);
        console.log(`[AIService] ${provider.name} rate limited (${remaining} remaining, resets at ${resetTime.toISOString()})`);

        if (this.fallbackEnabled && !isLastProvider) {
          continue;
        }

        throw new AIRateLimitExceededError(provider.name, remaining, resetTime);
      }

      try {
        console.log(`[AIService] Using ${provider.name}`);
        const result = await provider.generate(options);
        this.rateLimiter.recordRequest(provider.name);
        return result;
      } catch (error) {
        const rateLimitCheck = factory.detectRateLimit(error);

        if (rateLimitCheck.is429) {
          this.rateLimiter.markExhausted(provider.name, rateLimitCheck.retryAfterMs);
          console.warn(`[AIService] ${provider.name} returned 429 (rate limited)`);

          if (this.fallbackEnabled && !isLastProvider) {
            console.log(`[AIService] Falling back to next provider...`);
            continue;
          }

          throw new AIRateLimitExceededError(
            provider.name,
            0,
            this.rateLimiter.getResetTime(provider.name)
          );
        }

        console.error(`[AIService] ${provider.name} generation failed:`, error);

        if (this.fallbackEnabled && !isLastProvider) {
          console.log(`[AIService] Falling back to next provider...`);
          continue;
        }

        throw new AIGenerationError(provider.name, error as Error);
      }
    }

    throw new AIProviderUnavailableError(
      requireVision ? ['vision'] : ['textGeneration'],
      attemptedProviders
    );
  }

  private getEligibleProviders(requireVision: boolean, requireSpatial: boolean): RegisteredProvider[] {
    return this.providers.filter(({ provider }) => {
      if (requireVision && !provider.capabilities.vision) return false;
      if (requireSpatial && !provider.capabilities.spatialReasoning) return false;
      if (!provider.capabilities.textGeneration) return false;
      return true;
    });
  }

  getRemainingRequests(provider: AIProviderName): number {
    return this.rateLimiter.getRemainingRequests(provider);
  }

  getProviderStatus(): Record<AIProviderName, { available: boolean; remaining: number; resetTime: Date }> {
    const status: Record<string, { available: boolean; remaining: number; resetTime: Date }> = {};

    for (const { provider } of this.providers) {
      const remaining = this.rateLimiter.getRemainingRequests(provider.name);
      const resetTime = this.rateLimiter.getResetTime(provider.name);
      status[provider.name] = {
        available: remaining > 0,
        remaining,
        resetTime,
      };
    }

    return status;
  }
}
