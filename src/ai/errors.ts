import type { AIProviderName } from './types.js';

export class AIRateLimitExceededError extends Error {
  public readonly provider: AIProviderName;
  public readonly remainingRequests: number;
  public readonly resetTime: Date;

  constructor(provider: AIProviderName, remainingRequests: number, resetTime: Date) {
    super(`Rate limit exceeded for provider: ${provider}. Resets at ${resetTime.toISOString()}`);
    this.name = 'AIRateLimitExceededError';
    this.provider = provider;
    this.remainingRequests = remainingRequests;
    this.resetTime = resetTime;
  }
}

export class AIProviderUnavailableError extends Error {
  public readonly requiredCapabilities: string[];
  public readonly attemptedProviders: AIProviderName[];

  constructor(requiredCapabilities: string[], attemptedProviders: AIProviderName[]) {
    super(
      `No available AI provider with required capabilities: [${requiredCapabilities.join(', ')}]. ` +
      `Attempted providers: [${attemptedProviders.join(', ')}]`
    );
    this.name = 'AIProviderUnavailableError';
    this.requiredCapabilities = requiredCapabilities;
    this.attemptedProviders = attemptedProviders;
  }
}

export class AIGenerationError extends Error {
  public readonly provider: AIProviderName;
  public readonly originalError: Error;

  constructor(provider: AIProviderName, originalError: Error) {
    super(`AI generation failed with provider ${provider}: ${originalError.message}`);
    this.name = 'AIGenerationError';
    this.provider = provider;
    this.originalError = originalError;
  }
}
