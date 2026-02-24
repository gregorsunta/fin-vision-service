export type {
  AIProviderName,
  AICapabilities,
  AIImageInput,
  AIGenerateOptions,
  AIGenerateResult,
  AIProvider,
  AIProviderConfig,
  AIServiceConfig,
} from './types.js';

export {
  AIRateLimitExceededError,
  AIProviderUnavailableError,
  AIGenerationError,
} from './errors.js';

export { RateLimiter, getRateLimiter } from './rate-limiter.js';
export { GeminiProvider, GroqProvider } from './providers/index.js';
export { AIService } from './ai-service.js';
export { loadAIConfig } from './config.js';

import { AIService } from './ai-service.js';
import { loadAIConfig } from './config.js';

let aiServiceInstance: AIService | null = null;

export function getAIService(): AIService {
  if (!aiServiceInstance) {
    const config = loadAIConfig();
    aiServiceInstance = new AIService(config);
  }
  return aiServiceInstance;
}
