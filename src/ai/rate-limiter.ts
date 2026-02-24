import type { AIProviderName } from './types.js';

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
    console.log(
      `[RateLimiter] ${provider}: ${entry.requests}/${config.maxRequests} requests used in current window`
    );
  }

  /**
   * Called when a provider returns a real 429. Sets the request count to max
   * so subsequent requests skip this provider until the window resets.
   */
  markExhausted(provider: AIProviderName, retryAfterMs?: number): void {
    const config = this.configs.get(provider);
    if (!config) {
      return;
    }

    const entry = this.getOrCreateEntry(provider);
    entry.requests = config.maxRequests;

    // If the provider told us when to retry, reset the window start so it
    // expires at that time instead of the default 24h boundary.
    if (retryAfterMs && retryAfterMs > 0) {
      entry.windowStart = Date.now() - config.windowMs + retryAfterMs;
    }

    console.log(
      `[RateLimiter] ${provider}: Marked as exhausted (real 429). ` +
      `Resets at ${this.getResetTime(provider).toISOString()}`
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
      console.log(`[RateLimiter] ${provider}: Rate limit window reset`);
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
