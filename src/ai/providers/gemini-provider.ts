import { GoogleGenerativeAI, GoogleGenerativeAIFetchError, Part } from '@google/generative-ai';
import type { AIProvider, AIProviderName, AIGenerateOptions, AIGenerateResult, AICapabilities, AIProviderConfig } from '../types.js';

export class GeminiProvider implements AIProvider {
  /**
   * Detects rate-limit errors thrown by the Google Generative AI SDK.
   * Used by the registry so AIService stays provider-agnostic.
   */
  static detectRateLimit(error: unknown): { is429: boolean; retryAfterMs?: number } {
    if (error instanceof GoogleGenerativeAIFetchError && error.status === 429) {
      return { is429: true };
    }
    return { is429: false };
  }

  readonly name: AIProviderName;
  readonly capabilities: AICapabilities;

  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(config: AIProviderConfig) {
    if (!config.apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.name = config.name;
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = config.model;

    // Lite and Nano variants are unreliable at spatial reasoning (bounding boxes).
    const isWeakSpatialModel = /lite|nano/i.test(this.model);
    this.capabilities = {
      vision: true,
      textGeneration: true,
      spatialReasoning: !isWeakSpatialModel,
    };
  }

  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      ...(options.systemPrompt && { systemInstruction: options.systemPrompt }),
    });

    const parts: Part[] = [{ text: options.prompt }];

    if (options.images && options.images.length > 0) {
      for (const image of options.images) {
        const imagePart: Part = {
          inlineData: {
            data: image.data.toString('base64'),
            mimeType: image.mimeType,
          },
        };
        parts.push(imagePart);
      }
    }

    const generationConfig: Record<string, unknown> = {};
    if (options.config?.temperature !== undefined) {
      generationConfig.temperature = options.config.temperature;
    }
    if (options.config?.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.config.maxTokens;
    }
    if (options.responseFormat === 'json') {
      generationConfig.responseMimeType = 'application/json';
      if (options.responseSchema) {
        generationConfig.responseSchema = options.responseSchema;
      }
    }

    const result = await model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
    });

    const responseText = result.response.text();

    return {
      text: responseText,
      provider: this.name,
      model: this.model,
    };
  }
}
