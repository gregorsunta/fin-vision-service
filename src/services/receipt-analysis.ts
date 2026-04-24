import { ImageAnnotatorClient } from '@google-cloud/vision';
import { AIService, getAIService } from '../ai/index.js';
import { extractReceiptData } from './ai-extraction/extractor.js';
import { extractTextDebug, type ExtractTextDebugResult } from './ocr/ocr-pipeline.js';

export type { ReceiptData, ReceiptItem, ValidationIssue, ConfidenceScores, ReceiptFormat, ReceiptRegion, ExtractionFlag, ExtractionFlagSource, ExtractionFlagReason } from './ai-extraction/schema.js';

/**
 * Public facade for receipt analysis. Historically this file was a 1464-line
 * "god class"; the implementation now lives in focused sub-modules:
 *
 *   services/ocr/preprocess.ts         — OSD rotation + sharp preprocessing
 *   services/ocr/ocr-pipeline.ts       — Vision + Tesseract multi-engine OCR
 *   services/ai-extraction/schema.ts   — Gemini schema + TypeScript interfaces
 *   services/ai-extraction/prompt-builder.ts — System/user/correction prompts
 *   services/ai-extraction/validator.ts     — Price/date/OCR cross-validation
 *   services/ai-extraction/extractor.ts    — Extraction orchestrator
 *
 * This class preserves the original public API so callers need no changes.
 */
export class ReceiptAnalysisService {
  private aiService: AIService;
  private visionClient: ImageAnnotatorClient;

  constructor(aiService?: AIService) {
    this.aiService = aiService || getAIService();
    this.visionClient = new ImageAnnotatorClient({
      keyFilename: process.env.GCP_CREDENTIALS_PATH || './gcp-credentials.json',
    });
  }

  public async analyzeReceipts(images: Buffer[]) {
    if (images.length === 0) return [];
    const image = images[0];
    try {
      const result = await extractReceiptData(this.aiService, this.visionClient, image);
      return [result];
    } catch (error) {
      throw new Error('Failed to analyze receipt. The model may have returned an invalid format.', {
        cause: error,
      });
    }
  }

  public async extractText(image: Buffer): Promise<string | null> {
    const { merged } = await extractTextDebug(this.visionClient, image, true);
    return merged;
  }

  public async extractTextDebug(image: Buffer, preprocess = true): Promise<ExtractTextDebugResult> {
    return extractTextDebug(this.visionClient, image, preprocess);
  }
}
