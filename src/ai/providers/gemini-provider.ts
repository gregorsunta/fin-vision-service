import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import type { AIProvider, AIGenerateOptions, AIGenerateResult, AICapabilities, AIProviderConfig } from '../types.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini' as const;
  readonly capabilities: AICapabilities = {
    vision: true,
    textGeneration: true,
  };

  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(config: AIProviderConfig) {
    if (!config.apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.model = config.model || DEFAULT_MODEL;
  }

  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const model = this.genAI.getGenerativeModel({ model: this.model });

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

    const generationConfig: { temperature?: number; maxOutputTokens?: number } = {};
    if (options.config?.temperature !== undefined) {
      generationConfig.temperature = options.config.temperature;
    }
    if (options.config?.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.config.maxTokens;
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
