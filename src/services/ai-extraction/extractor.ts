import { ImageAnnotatorClient } from '@google-cloud/vision';
import type { AIService, AIGenerateResult } from '../../ai/index.js';
import { createLogger } from '../../utils/logger.js';
import { extractTextWithVision } from '../ocr/ocr-pipeline.js';
import { buildSystemPrompt, buildUserPrompt, buildCorrectionPrompt } from './prompt-builder.js';
import { receiptExtractionSchema } from './schema.js';
import { validatePrices, crossValidateWithOCR } from './validator.js';
import type { ReceiptData } from './schema.js';

const log = createLogger('services.ai-extraction.extractor');

function parseResponse(result: AIGenerateResult): ReceiptData {
  let cleanedText = result.text.trim();
  cleanedText = cleanedText.replace(/^```(?:json)?\n?/gm, '');
  cleanedText = cleanedText.replace(/\n?```$/gm, '');
  cleanedText = cleanedText.trim();
  log.debug({ provider: result.provider, preview: cleanedText.substring(0, 200) }, 'AI response received');
  return JSON.parse(cleanedText);
}

/**
 * Fills missing lineTotals by computing qty × unitPrice as fallback.
 * For five-column-discount format, sanity-checks that AI-read lineTotal
 * doesn't exceed the computed value (would indicate double-counting the
 * discount column).
 */
function computeLineTotals(receipt: ReceiptData): void {
  if (!receipt.items) return;
  const hasFiveColumn = receipt.receiptFormat === 'five-column-discount';

  for (const item of receipt.items) {
    if (item.lineTotal === undefined || item.lineTotal === null) {
      item.lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
    } else if (hasFiveColumn && item.itemType !== 'discount') {
      const computed = Math.round(item.quantity * item.unitPrice * 100) / 100;
      if (item.lineTotal > computed + 0.02) {
        log.warn(
          { description: item.description, lineTotal: item.lineTotal, computed },
          'five-column sanity fail: lineTotal > computed, resetting (AI likely double-added discount column)',
        );
        item.lineTotal = computed;
      }
    }
  }
}

/**
 * Main extraction orchestrator:
 *   1. OCR (Vision + Tesseract)
 *   2. Build prompts
 *   3. AI generate (Gemini/Groq via AIService)
 *   4. Parse JSON (with JSON-parse retry on failure)
 *   5. computeLineTotals + validatePrices
 *   6. Price-mismatch retry with corrective prompt (up to 1 retry)
 *   7. Cross-validate against OCR text
 *   8. Attach processingMetadata
 *
 * Throws with `cause` chained so the worker can walk the error chain and
 * detect rate-limit errors — which must NOT mark the receipt as 'failed'.
 */
export async function extractReceiptData(
  aiService: AIService,
  visionClient: ImageAnnotatorClient,
  image: Buffer,
): Promise<ReceiptData> {
  const ocrText = await extractTextWithVision(visionClient, image);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(ocrText);

  const generateOptions = {
    prompt: userPrompt,
    systemPrompt,
    images: [{ data: image, mimeType: 'image/jpeg' }],
    requireVision: true,
    responseFormat: 'json' as const,
    responseSchema: receiptExtractionSchema,
    config: { temperature: 0, maxTokens: 4096 },
  };

  let result = await aiService.generate(generateOptions);
  let analysisResult: ReceiptData;

  try {
    analysisResult = parseResponse(result);
  } catch {
    log.warn('JSON parse failed, retrying with parse correction prompt');
    const retryResult = await aiService.generate({
      ...generateOptions,
      prompt:
        userPrompt +
        '\n\nCRITICAL: Your previous response was not valid JSON. Return ONLY a valid JSON object, no other text.',
    });
    analysisResult = parseResponse(retryResult);
    result = retryResult;
  }

  computeLineTotals(analysisResult);
  validatePrices(analysisResult);

  const hasPriceMismatch = analysisResult.validationIssues?.some((i) => i.type === 'PRICE_MISMATCH');

  if (hasPriceMismatch) {
    log.info('price mismatch detected, retrying with corrective prompt');
    const calculatedTotal = analysisResult.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);
    const correctionPrompt = buildCorrectionPrompt(ocrText, calculatedTotal, analysisResult.total);

    try {
      const retryResult = await aiService.generate({ ...generateOptions, prompt: correctionPrompt });
      const retryAnalysis = parseResponse(retryResult);
      computeLineTotals(retryAnalysis);
      validatePrices(retryAnalysis);

      const retryHasMismatch = retryAnalysis.validationIssues?.some((i) => i.type === 'PRICE_MISMATCH');
      if (!retryHasMismatch) {
        log.info('retry resolved price mismatch');
        analysisResult = retryAnalysis;
        result = retryResult;
      } else {
        const origDiff = Math.abs(calculatedTotal - analysisResult.total);
        const retryCalcTotal = retryAnalysis.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);
        const retryDiff = Math.abs(retryCalcTotal - retryAnalysis.total);
        if (retryDiff < origDiff) {
          analysisResult = retryAnalysis;
          result = retryResult;
        }
        log.warn('retry did not fully resolve price mismatch, using best result');
      }
    } catch (retryError) {
      log.warn({ err: retryError }, 'retry failed, using original result');
    }
  }

  if (ocrText) {
    crossValidateWithOCR(analysisResult, ocrText);
  }

  analysisResult.processingMetadata = {
    ocrUsed: ocrText !== null,
    ...(ocrText !== null && {
      ocrProvider: 'google_cloud_vision',
      ocrCharCount: ocrText.length,
    }),
    analysisModel: result.model,
    analysisProvider: result.provider,
    processedAt: new Date().toISOString(),
    receiptFormat: analysisResult.receiptFormat ?? 'simple',
    region: analysisResult.region ?? 'eu',
    ...(hasPriceMismatch && { retryCount: 1, retryReason: 'PRICE_MISMATCH' }),
  };

  if (ocrText) {
    analysisResult.ocrText = ocrText;
  }

  return analysisResult;
}
