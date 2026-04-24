import type { AIProvider, AIProviderName, AIGenerateOptions, AIGenerateResult, AIServiceConfig } from './types.js';
import { AIRateLimitExceededError, AIProviderUnavailableError, AIGenerationError } from './errors.js';
import { getRateLimiter, RateLimiter } from './rate-limiter.js';
import { getProviderFactory, type ProviderFactory } from './providers/index.js';
import { getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai.service');
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
        log.warn({ kind: providerConfig.kind }, 'unknown provider kind');
        continue;
      }

      const provider = factory.create(providerConfig);
      this.providers.push({ provider, factory });
      this.rateLimiter.configure(
        provider.name,
        providerConfig.rateLimit || 1000,
        RATE_LIMIT_WINDOW_MS
      );
      log.info(
        { provider: provider.name, rateLimit: providerConfig.rateLimit || 1000, vision: provider.capabilities.vision },
        'registered AI provider',
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
    const MAX_TRANSIENT_RETRIES = getConfig().AI_MAX_TRANSIENT_RETRIES;

    for (let i = 0; i < eligibleProviders.length; i++) {
      const { provider, factory } = eligibleProviders[i];
      const isLastProvider = i === eligibleProviders.length - 1;
      attemptedProviders.push(provider.name);
      let transientRetries = 0;

      if (!this.rateLimiter.canMakeRequest(provider.name)) {
        const remaining = this.rateLimiter.getRemainingRequests(provider.name);
        const resetTime = this.rateLimiter.getResetTime(provider.name);
        log.info({ provider: provider.name, remaining, resetTime: resetTime.toISOString() }, 'provider internally rate limited');

        // Skip to fallback only when a fallback is available.
        // If this is the last provider, attempt the real API call — the internal
        // limiter's backoff may have expired or been set by a different worker
        // instance, so we let the API be the authoritative source.
        if (this.fallbackEnabled && !isLastProvider) {
          continue;
        }

        log.info({ provider: provider.name }, 'no fallback available, attempting provider despite internal backoff');
      }

      // Inner retry loop for transient errors (503 overloaded, etc.)
      while (true) {
        try {
          log.debug(
            { provider: provider.name, retry: transientRetries, maxRetries: MAX_TRANSIENT_RETRIES },
            'using provider',
          );
          const result = await provider.generate(options);
          this.rateLimiter.recordRequest(provider.name);
          return result;
        } catch (error) {
          const rateLimitCheck = factory.detectRateLimit(error);

          if (rateLimitCheck.is429) {
            this.rateLimiter.markExhausted(provider.name, rateLimitCheck.retryAfterMs);
            log.warn({ provider: provider.name }, 'provider returned 429 (rate limited)');

            if (this.fallbackEnabled && !isLastProvider) {
              log.info({ provider: provider.name }, 'falling back to next provider');
              break; // break inner while → continue outer for
            }

            throw new AIRateLimitExceededError(
              provider.name,
              0,
              this.rateLimiter.getResetTime(provider.name)
            );
          }

          if (rateLimitCheck.isTransient && transientRetries < MAX_TRANSIENT_RETRIES) {
            transientRetries++;
            const backoffMs = transientRetries * 5000;
            log.warn({ provider: provider.name, backoffMs, retry: transientRetries }, 'provider returned transient error (503), retrying');
            await new Promise(r => setTimeout(r, backoffMs));
            continue; // retry same provider
          }

          log.error({ err: error, provider: provider.name }, 'provider generation failed');

          if (this.fallbackEnabled && !isLastProvider) {
            log.info({ provider: provider.name }, 'falling back to next provider');
            break; // break inner while → continue outer for
          }

          throw new AIGenerationError(provider.name, error as Error);
        }
        break; // successful result already returned; this line is unreachable but satisfies the loop
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
