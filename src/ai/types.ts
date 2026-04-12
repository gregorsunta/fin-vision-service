/**
 * Unique identifier for a provider instance, e.g. "gemini:gemini-2.5-flash".
 * Each instance has its own rate limiter and represents one model on one backend.
 */
export type AIProviderName = string;

/** The underlying provider implementation type. */
export type AIProviderKind = 'gemini' | 'groq';

export interface AICapabilities {
  vision: boolean;
  textGeneration: boolean;
  /**
   * Whether the model is reliable at spatial reasoning tasks like bounding box
   * detection. "Lite" / "Nano" tier models tend to be unreliable here, so
   * spatial-critical callers (e.g. the receipt splitter) should opt out of
   * falling back to them.
   */
  spatialReasoning: boolean;
}

export interface AIImageInput {
  data: Buffer;
  mimeType: string;
}

export interface AIGenerateOptions {
  prompt: string;
  systemPrompt?: string;
  images?: AIImageInput[];
  config?: {
    temperature?: number;
    maxTokens?: number;
  };
  responseFormat?: 'text' | 'json';
  responseSchema?: object;
  requireVision?: boolean;
  /**
   * If true, only providers with `capabilities.spatialReasoning === true` are
   * eligible. Use for tasks like bounding box detection where weaker models
   * (Flash Lite, Nano) produce unusable results.
   */
  requireSpatialReasoning?: boolean;
}

export interface AIGenerateResult {
  text: string;
  provider: AIProviderName;
  model: string;
}

export interface AIProvider {
  readonly name: AIProviderName;
  readonly capabilities: AICapabilities;
  generate(options: AIGenerateOptions): Promise<AIGenerateResult>;
}

export interface AIProviderConfig {
  /** Unique instance name, e.g. "gemini:gemini-2.5-flash" */
  name: AIProviderName;
  kind: AIProviderKind;
  apiKey: string;
  model: string;
  rateLimit?: number;
}

export interface AIServiceConfig {
  fallbackEnabled: boolean;
  /**
   * Ordered list of provider instances. The first entry is tried first; on
   * rate limit or failure, the service falls back to the next.
   */
  providers: AIProviderConfig[];
}
