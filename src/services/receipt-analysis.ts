import { GoogleGenerativeAI, Part } from '@google/generative-ai';

// Updated structure to include keywords
export interface ReceiptItem {
  description: string;
  quantity: number;
  price: number;
  keywords?: string[];
}

export interface ReceiptData {
  merchantName: string;
  transactionDate: string;
  transactionTime: string;
  items: ReceiptItem[];
  subtotal: number | null;
  tax: number | null;
  total: number;
  currency: string;
  keywords?: string[];
}

export class ReceiptAnalysisService {
  private genAI: GoogleGenerativeAI;
  private readonly GEMINI_API_KEY: string;

  constructor() {
    this.GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
    if (!this.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set in the environment variables');
    }
    this.genAI = new GoogleGenerativeAI(this.GEMINI_API_KEY);
  }

  /**
   * Analyzes a single receipt image and extracts structured data.
   * @param image A Buffer containing the receipt image.
   * @returns A promise that resolves to an array containing a single ReceiptData object.
   */
  public async analyzeReceipts(images: Buffer[]): Promise<ReceiptData[]> {
    if (images.length === 0) {
      return [];
    }
    // This service now processes one image at a time as per the new workflow,
    // but we keep the array input to maintain a consistent interface and handle the single image.
    const image = images[0];

    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const imagePart: Part = {
      inlineData: {
        data: image.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const prompt = `
      You are an expert receipt processing engine. Your task is to analyze the provided receipt image with extreme accuracy.
      First, assess the image quality. If the image is too blurry, dark, or unreadable to confidently extract data, return an empty JSON object {}.
      
      If the image is readable, extract the following details into a structured JSON object.

      The desired JSON structure is:
      {
        "merchantName": "string",
        "transactionDate": "string (YYYY-MM-DD)",
        "transactionTime": "string (HH:MM:SS)",
        "items": [{ "description": "string", "quantity": "number", "price": "number", "keywords": ["string", "string"] }],
        "subtotal": "number | null",
        "tax": "number | null",
        "total": "number",
        "currency": "string (ISO 4217 code, e.g., 'USD')",
        "keywords": ["string", "string"]
      }

      - The 'total' field is mandatory. If you cannot find it, do not process the receipt.
      - For 'keywords' at the root level, provide general categories for the overall purchase (e.g., "groceries", "electronics", "dinner").
      - For 'keywords' at the item level, provide specific categories for each item (e.g., "fruit", "vegetable", "beverage", "CPU").
      - If a value is not present, use null where allowed (subtotal, tax).
      - Ensure all monetary values are numbers, not strings.

      Return your response as a single, clean JSON object. Do not include any other text, explanation, or markdown code fences.
    `;

    try {
      const result = await model.generateContent([prompt, imagePart]);
      const responseText = result.response.text();
      // Clean potential markdown fences
      const cleanedText = responseText.replace(/```json\n|```/g, '').trim();
      const analysisResult: ReceiptData = JSON.parse(cleanedText);
      
      // Return as an array to match the expected return type
      return [analysisResult];
    } catch (error) {
      console.error('Error analyzing receipt with Gemini:', error);
      throw new Error('Failed to analyze receipt. The model may have returned an invalid format.');
    }
  }
}