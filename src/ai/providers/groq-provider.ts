import Groq, { RateLimitError as GroqRateLimitError } from 'groq-sdk';
import type {
  AIProvider,
  AIProviderName,
  AIGenerateOptions,
  AIGenerateResult,
  AICapabilities,
  AIProviderConfig,
} from '../types.js';

/**
 * Groq provider. Supports both text-only models (Llama 3.x) and vision-capable
 * models (Llama 4 Scout/Maverick, Llama 3.2 Vision). Capabilities are derived
 * from the model name at construction time.
 */
export class GroqProvider implements AIProvider {
  static detectRateLimit(error: unknown): { is429: boolean; retryAfterMs?: number } {
    if (error instanceof GroqRateLimitError) {
      const retryAfter = (error.headers as Record<string, string> | undefined)?.['retry-after'];
      const retryAfterMs = retryAfter ? parseFloat(retryAfter) * 1000 : undefined;
      return { is429: true, retryAfterMs };
    }
    return { is429: false };
  }

  readonly name: AIProviderName;
  readonly capabilities: AICapabilities;

  private client: Groq;
  private model: string;

  constructor(config: AIProviderConfig) {
    if (!config.apiKey) {
      throw new Error('Groq API key is required');
    }
    this.name = config.name;
    this.client = new Groq({ apiKey: config.apiKey });
    this.model = config.model;

    // Vision-capable Groq models: Llama 4 family + Llama 3.2 vision previews.
    // Anything else (Llama 3.3 70b, Mixtral, Gemma, etc.) is text-only.
    const isVisionModel = /llama-4|vision|llava|maverick|scout/i.test(this.model);
    this.capabilities = {
      vision: isVisionModel,
      textGeneration: true,
      // Groq vision models are general-purpose; not reliable for bbox detection.
      // The cv-detector sidecar handles spatial tasks anyway.
      spatialReasoning: false,
    };
  }

  async generate(options: AIGenerateOptions): Promise<AIGenerateResult> {
    if (options.images && options.images.length > 0 && !this.capabilities.vision) {
      throw new Error(
        `Groq model ${this.model} does not support vision input. Use a Llama 4 vision model.`
      );
    }

    // Build OpenAI-style messages. System prompt as a separate `system` role
    // message; user message uses multimodal content array when images are present.
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    if (options.images && options.images.length > 0) {
      const userContent: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [{ type: 'text', text: options.prompt }];

      for (const image of options.images) {
        const base64 = image.data.toString('base64');
        userContent.push({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${base64}` },
        });
      }
      messages.push({ role: 'user', content: userContent as any });
    } else {
      messages.push({ role: 'user', content: options.prompt });
    }

    // Groq's json_object mode requires the word "json" to appear in the
    // messages. Our system prompt always describes a JSON schema, so this is
    // satisfied. We don't pass `response_format: json_schema` because the
    // schema in receipt-analysis.ts uses Gemini-specific SchemaType values
    // and translating it isn't worth the complexity — the system prompt
    // already specifies the structure in detail.
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: options.config?.temperature,
      max_tokens: options.config?.maxTokens,
      response_format: options.responseFormat === 'json' ? { type: 'json_object' } : undefined,
    });

    const responseText = response.choices[0]?.message?.content || '';

    return {
      text: responseText,
      provider: this.name,
      model: this.model,
    };
  }
}
