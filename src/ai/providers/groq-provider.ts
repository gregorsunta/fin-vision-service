import Groq from 'groq-sdk';
import type { AIProvider, AIGenerateOptions, AIGenerateResult, AICapabilities, AIProviderConfig } from '../types.js';

const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export class GroqProvider implements AIProvider {
  readonly name = 'groq' as const;
  readonly capabilities: AICapabilities = {
    vision: false,
    textGeneration: true,
  };

  private client: Groq;
  private model: string;

  constructor(config: AIProviderConfig) {
    if (!config.apiKey) {
      throw new Error('Groq API key is required');
    }
    this.client = new Groq({ apiKey: config.apiKey });
    this.model = config.model || DEFAULT_MODEL;
  }

  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    if (options.images && options.images.length > 0) {
      throw new Error('Groq provider does not support vision/image inputs');
    }

    const chatCompletion = await this.client.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: options.prompt,
        },
      ],
      model: this.model,
      temperature: options.config?.temperature,
      max_tokens: options.config?.maxTokens,
      response_format: options.responseFormat === 'json' ? { type: 'json_object' } : undefined,
    });

    const responseText = chatCompletion.choices[0]?.message?.content || '';

    return {
      text: responseText,
      provider: this.name,
      model: this.model,
    };
  }
}
