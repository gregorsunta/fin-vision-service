import type { AIProviderName } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai.rate-limiter');

interface RateLimitEntry {
  requests: number;
  windowStart: number;
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export class RateLimiter {
  private limits: Map<AIProviderName, RateLimitEntry> = new Map();
  private configs: Map<AIProviderName, RateLimitConfig> = new Map();

  constructor() {
    this.limits = new Map();
    this.configs = new Map();
  }

  configure(provider: AIProviderName, maxRequests: number, windowMs: number = DEFAULT_WINDOW_MS): void {
    this.configs.set(provider, { maxRequests, windowMs });
    if (!this.limits.has(provider)) {
      this.limits.set(provider, { requests: 0, windowStart: Date.now() });
    }
  }

  canMakeRequest(provider: AIProviderName): boolean {
    const config = this.configs.get(provider);
    if (!config) {
      return true;
    }

    const entry = this.getOrCreateEntry(provider);
    this.resetWindowIfExpired(provider, entry, config);

    return entry.requests < config.maxRequests;
  }

  recordRequest(provider: AIProviderName): void {
    const config = this.configs.get(provider);
    if (!config) {
      return;
    }

    const entry = this.getOrCreateEntry(provider);
    this.resetWindowIfExpired(provider, entry, config);

    entry.requests++;
    log.debug(
      { provider, used: entry.requests, max: config.maxRequests },
      'rate limiter recorded request',
    );
  }

  /**
   * Called when a provider returns a real 429. Sets the request count to max
   * so subsequent requests skip this provider until the window resets.
   *
   * If no retry-after hint is given, assume a short-term per-minute limit
   * (60s) rather than a daily quota — this avoids locking the provider out
   * for 24 hours when the actual issue is a transient per-minute throttle.
   */
  markExhausted(provider: AIProviderName, retryAfterMs?: number): void {
    const config = this.configs.get(provider);
    if (!config) {
      return;
    }

    const entry = this.getOrCreateEntry(provider);
    entry.requests = config.maxRequests;

    // Default to 60s back-off if the provider didn't tell us when to retry.
    const backoffMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : 60_000;
    entry.windowStart = Date.now() - config.windowMs + backoffMs;

    log.info(
      {
        provider,
        backoffSeconds: Math.round(backoffMs / 1000),
        resetTime: this.getResetTime(provider).toISOString(),
      },
      'rate limiter marked provider as exhausted (real 429)',
    );
  }

  getRemainingRequests(provider: AIProviderName): number {
    const config = this.configs.get(provider);
    if (!config) {
      return Infinity;
    }

    const entry = this.getOrCreateEntry(provider);
    this.resetWindowIfExpired(provider, entry, config);

    return Math.max(0, config.maxRequests - entry.requests);
  }

  getResetTime(provider: AIProviderName): Date {
    const config = this.configs.get(provider);
    if (!config) {
      return new Date();
    }

    const entry = this.getOrCreateEntry(provider);
    return new Date(entry.windowStart + config.windowMs);
  }

  private getOrCreateEntry(provider: AIProviderName): RateLimitEntry {
    let entry = this.limits.get(provider);
    if (!entry) {
      entry = { requests: 0, windowStart: Date.now() };
      this.limits.set(provider, entry);
    }
    return entry;
  }

  private resetWindowIfExpired(
    provider: AIProviderName,
    entry: RateLimitEntry,
    config: RateLimitConfig
  ): void {
    const now = Date.now();
    if (now - entry.windowStart >= config.windowMs) {
      log.info({ provider }, 'rate limit window reset');
      entry.requests = 0;
      entry.windowStart = now;
    }
  }
}

let rateLimiterInstance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter();
  }
  return rateLimiterInstance;
}
