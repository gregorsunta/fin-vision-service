import { HarmBlockThreshold, HarmCategory, SchemaType, } from '@google/generative-ai';
/**
 * Defines the structured response format for receipt data extraction.
 * This schema is used to instruct the Gemini model to return a JSON object
 * with a specific structure.
 */
const receiptExtractionSchema = {
    name: 'extract_receipt_data',
    description: 'Extracts structured data from a receipt image or text. Captures store details, line items, and totals.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            store_name: {
                type: SchemaType.STRING,
                description: 'The name of the store or vendor.',
            },
            total_amount: {
                type: SchemaType.NUMBER,
                description: 'The final total amount of the transaction.',
            },
            tax_amount: {
                type: SchemaType.NUMBER,
                description: 'The total tax amount, if available.',
            },
            transaction_date: {
                type: SchemaType.STRING,
                description: 'The date of the transaction in YYYY-MM-DD format.',
            },
            line_items: {
                type: SchemaType.ARRAY,
                description: 'A list of all items purchased.',
                items: {
                    type: SchemaType.OBJECT,
                    properties: {
                        description: {
                            type: SchemaType.STRING,
                            description: "The description of the purchased item.",
                        },
                        qty: {
                            type: SchemaType.NUMBER,
                            description: 'The quantity of the item purchased.',
                        },
                        unit_price: {
                            type: SchemaType.NUMBER,
                            description: 'The price per unit of the item.',
                        },
                    },
                    required: ['description', 'qty', 'unit_price'],
                },
            },
        },
        required: [
            'store_name',
            'total_amount',
            'transaction_date',
            'line_items',
        ],
    },
};
/**
 * Manages the generation of prompts and model configuration for interacting
 * with the Gemini API.
 */
export class PromptManager {
    /**
     * Generates the complete tool configuration for the Gemini model, including the
     * dynamically structured data extraction schema.
     *
     * @param {string[]} [extraFields=[]] - A list of extra top-level string fields to add to the extraction schema.
     * @returns {Tool} The tool configuration for the Gemini API.
     */
    getExtractionTool(extraFields = []) {
        const dynamicSchema = { ...receiptExtractionSchema };
        if (extraFields.length > 0 && dynamicSchema.parameters && dynamicSchema.parameters.properties) {
            extraFields.forEach((field) => {
                if (dynamicSchema.parameters && dynamicSchema.parameters.properties) {
                    dynamicSchema.parameters.properties[field] = {
                        type: SchemaType.STRING,
                        description: `An extra field for ${field}.`,
                    };
                }
            });
        }
        return {
            functionDeclarations: [dynamicSchema],
        };
    }
    /**
     * Returns the generation config for the model.
     */
    getGenerationConfig() {
        return {
            // responseMimeType: 'application/json' is set in the model params directly
            // as per latest SDK guidance for function calling.
            temperature: 0.2,
            maxOutputTokens: 2048,
            topP: 0.95,
            topK: 40,
        };
    }
    /**
     * Returns safety settings to block harmful content.
     */
    getSafetySettings() {
        return [
            {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
        ];
    }
    /**
     * Creates the main textual prompt for the AI.
     * @param {string} ocrText - The text extracted from the receipt via OCR.
     * @returns {string} The prompt to send to the Gemini model.
     */
    createExtractionPrompt(ocrText) {
        return `
      You are an expert receipt processing agent. Your task is to analyze the provided
      OCR text from a receipt and extract the key information in the requested JSON format.

      Please analyze the following receipt text:
      ---
      ${ocrText}
      ---

      Extract the store name, total amount, tax amount, transaction date, and all line items.
      Ensure the transaction date is in YYYY-MM-DD format.
      If a value is not present, leave it null. For line items, do your best to parse
      the description, quantity, and price.
    `;
    }
}
