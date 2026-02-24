export type AIProviderName = 'gemini' | 'groq';

export interface AICapabilities {
  vision: boolean;
  textGeneration: boolean;
}

export interface AIImageInput {
  data: Buffer;
  mimeType: string;
}

export interface AIGenerateOptions {
  prompt: string;
  images?: AIImageInput[];
  config?: {
    temperature?: number;
    maxTokens?: number;
  };
  responseFormat?: 'text' | 'json';
  requireVision?: boolean;
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
  apiKey: string;
  model?: string;
  rateLimit?: number;
}

export interface AIServiceConfig {
  primaryProvider: AIProviderName;
  fallbackEnabled: boolean;
  providers: {
    gemini?: AIProviderConfig;
    groq?: AIProviderConfig;
  };
}
