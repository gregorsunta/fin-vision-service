import { AIRateLimitExceededError } from '../../ai/errors.js';

/**
 * Walks up to five levels of `.cause` looking for an AIRateLimitExceededError.
 * Providers often wrap the rate limit in generic Error messages, so a shallow
 * instanceof check misses them.
 */
export function extractRateLimitError(err: unknown): AIRateLimitExceededError | null {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    if (current instanceof AIRateLimitExceededError) return current;
    current = (current as { cause?: unknown })?.cause;
  }
  return null;
}

export function isRateLimitError(err: unknown): boolean {
  return extractRateLimitError(err) !== null;
}
