import { ImageAnnotatorClient } from '@google-cloud/vision';
import { SchemaType } from '@google/generative-ai';
import sharp from 'sharp';
import { createWorker, OEM, type Worker as TesseractWorker } from 'tesseract.js';
import { AIService, getAIService, AIGenerateResult } from '../ai/index.js';
import { buildCategoryPromptList } from './categories.js';

// Module-level singleton — Tesseract workers are heavy (~50MB RAM, ~3-5s
// initialization downloading language data). One shared worker per process
// is reused across all receipt processing calls.
let tesseractWorkerPromise: Promise<TesseractWorker> | null = null;
async function getTesseractWorker(): Promise<TesseractWorker> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = createWorker(['slv', 'eng', 'deu']).catch((err) => {
      tesseractWorkerPromise = null;
      throw err;
    });
  }
  return tesseractWorkerPromise;
}

// Separate OSD worker — `osd` traineddata is required for orientation detection
// and is incompatible with language traineddata in the same worker.
let osdWorkerPromise: Promise<TesseractWorker> | null = null;
async function getOsdWorker(): Promise<TesseractWorker> {
  if (!osdWorkerPromise) {
    osdWorkerPromise = createWorker('osd', OEM.TESSERACT_ONLY).catch((err) => {
      osdWorkerPromise = null;
      throw err;
    });
  }
  return osdWorkerPromise;
}

const receiptExtractionSchema = {
  type: SchemaType.OBJECT,
  properties: {
    merchantName: { type: SchemaType.STRING },
    transactionDate: { type: SchemaType.STRING },
    transactionTime: { type: SchemaType.STRING },
    items: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          description: { type: SchemaType.STRING },
          quantity: { type: SchemaType.NUMBER },
          quantityUnit: { type: SchemaType.STRING, nullable: true },
          unitPrice: { type: SchemaType.NUMBER },
          keywords: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          category: { type: SchemaType.STRING, nullable: true },
          subcategory: { type: SchemaType.STRING, nullable: true },
          confidence: { type: SchemaType.NUMBER },
          itemType: {
            type: SchemaType.STRING,
            enum: ['product', 'discount', 'tax', 'tip', 'fee', 'refund', 'adjustment'],
          },
          discountMetadata: {
            type: SchemaType.OBJECT,
            nullable: true,
            properties: {
              type: { type: SchemaType.STRING, nullable: true },
              value: { type: SchemaType.NUMBER, nullable: true },
              code: { type: SchemaType.STRING, nullable: true },
              originalPrice: { type: SchemaType.NUMBER, nullable: true },
            },
          },
        },
        required: ['description', 'quantity', 'unitPrice', 'itemType'],
      },
    },
    subtotal: { type: SchemaType.NUMBER, nullable: true },
    tax: { type: SchemaType.NUMBER, nullable: true },
    total: { type: SchemaType.NUMBER },
    currency: { type: SchemaType.STRING },
    keywords: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    confidenceScores: {
      type: SchemaType.OBJECT,
      properties: {
        merchantName: { type: SchemaType.NUMBER },
        transactionDate: { type: SchemaType.NUMBER },
        total: { type: SchemaType.NUMBER },
        items: { type: SchemaType.NUMBER },
      },
      required: ['merchantName', 'transactionDate', 'total', 'items'],
    },
  },
  required: ['merchantName', 'transactionDate', 'transactionTime', 'items', 'total', 'currency', 'confidenceScores'],
};

export interface ReceiptItem {
  description: string;
  quantity: number;
  quantityUnit?: string;
  unitPrice: number;
  lineTotal?: number;
  keywords?: string[];
  category?: string;
  subcategory?: string;
  confidence?: number;

  itemType?: 'product' | 'discount' | 'tax' | 'tip' | 'fee' | 'refund' | 'adjustment';

  discountMetadata?: {
    type?: 'percentage' | 'fixed' | 'coupon' | 'loyalty' | 'promotion';
    value?: number;
    code?: string;
    originalPrice?: number;
  };
}

export interface ValidationIssue {
  severity: 'warning' | 'error';
  type: 'PRICE_MISMATCH' | 'INVALID_PRICE' | 'UNREALISTIC_PRICE' | 'INVALID_DATE' | 'UNREALISTIC_QUANTITY' | 'MISSING_MERCHANT' | 'OCR_MISMATCH' | 'LOW_IMAGE_QUALITY';
  message: string;
  details?: any;
}

export interface ConfidenceScores {
  merchantName: number;
  transactionDate: number;
  total: number;
  items: number;
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
  ocrText?: string;
  confidenceScores?: ConfidenceScores;
  validationIssues?: ValidationIssue[];
  processingMetadata?: {
    ocrUsed: boolean;
    ocrProvider?: string;
    ocrCharCount?: number;
    analysisModel: string;
    analysisProvider?: string;
    processedAt: string;
    retryCount?: number;
    retryReason?: string;
  };
}

export class ReceiptAnalysisService {
  private aiService: AIService;
  private visionClient: ImageAnnotatorClient;

  constructor(aiService?: AIService) {
    this.aiService = aiService || getAIService();
    this.visionClient = new ImageAnnotatorClient({
      keyFilename: process.env.GCP_CREDENTIALS_PATH || './gcp-credentials.json',
    });
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
    const image = images[0];

    const ocrText = await this.extractTextWithVision(image);
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(ocrText);

    try {
      // Always send image + OCR text for maximum accuracy (dual-source)
      const generateOptions = {
        prompt: userPrompt,
        systemPrompt,
        images: [{ data: image, mimeType: 'image/jpeg' }],
        requireVision: true,
        responseFormat: 'json' as const,
        responseSchema: receiptExtractionSchema,
        config: { temperature: 0, maxTokens: 4096 },
      };

      let result = await this.aiService.generate(generateOptions);
      let analysisResult: ReceiptData;

      try {
        analysisResult = this.parseResponse(result);
      } catch (parseError) {
        console.warn('⚠️  JSON parse failed, retrying with parse correction prompt...');
        const retryResult = await this.aiService.generate({
          ...generateOptions,
          prompt: userPrompt + '\n\nCRITICAL: Your previous response was not valid JSON. Return ONLY a valid JSON object, no other text.',
        });
        analysisResult = this.parseResponse(retryResult);
        result = retryResult;
      }

      this.computeLineTotals(analysisResult);
      this.validatePrices(analysisResult);

      // Retry once if price mismatch detected
      const hasPriceMismatch = analysisResult.validationIssues?.some(
        (i) => i.type === 'PRICE_MISMATCH'
      );

      if (hasPriceMismatch) {
        console.log('⚠️  Price mismatch detected, retrying with corrective prompt...');
        const calculatedTotal = analysisResult.items.reduce(
          (sum, item) => sum + (item.lineTotal ?? 0), 0
        );
        const correctionPrompt = this.buildCorrectionPrompt(
          ocrText, calculatedTotal, analysisResult.total
        );

        try {
          const retryResult = await this.aiService.generate({
            ...generateOptions,
            prompt: correctionPrompt,
          });
          const retryAnalysis = this.parseResponse(retryResult);
          this.computeLineTotals(retryAnalysis);
          this.validatePrices(retryAnalysis);

          const retryHasMismatch = retryAnalysis.validationIssues?.some(
            (i) => i.type === 'PRICE_MISMATCH'
          );

          if (!retryHasMismatch) {
            console.log('✓ Retry resolved price mismatch');
            analysisResult = retryAnalysis;
            result = retryResult;
          } else {
            // Keep whichever has a smaller diff
            const origDiff = Math.abs(
              calculatedTotal - analysisResult.total
            );
            const retryCalcTotal = retryAnalysis.items.reduce(
              (sum, item) => sum + (item.lineTotal ?? 0), 0
            );
            const retryDiff = Math.abs(retryCalcTotal - retryAnalysis.total);
            if (retryDiff < origDiff) {
              analysisResult = retryAnalysis;
              result = retryResult;
            }
            console.warn('⚠️  Retry did not fully resolve price mismatch, using best result');
          }

          // Last-resort: if items still sum HIGHER than total, the model
          // consistently can't find the discount line. Add a synthetic
          // discount item for the difference so downstream math works and
          // remove the PRICE_MISMATCH issue. Mark with a clear note.
          this.reconcileWithSyntheticDiscount(analysisResult);
        } catch (retryError) {
          console.warn('⚠️  Retry failed, using original result:', retryError);
        }
      }

      // Cross-validate extracted values against OCR text
      if (ocrText) {
        this.crossValidateWithOCR(analysisResult, ocrText);
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
        ...(hasPriceMismatch && { retryCount: 1, retryReason: 'PRICE_MISMATCH' }),
      };

      if (ocrText) {
        analysisResult.ocrText = ocrText;
      }

      return [analysisResult];
    } catch (error) {
      console.error('Error analyzing receipt:', error);
      // Preserve the original error via `cause` so the worker can walk the
      // chain and detect rate-limit errors (which should NOT mark the receipt
      // as 'failed' — they leave it 'pending' for later resume).
      throw new Error('Failed to analyze receipt. The model may have returned an invalid format.', { cause: error });
    }
  }

  private parseResponse(result: AIGenerateResult): ReceiptData {
    let cleanedText = result.text.trim();
    // Fallback: clean markdown fences if structured output wasn't used
    cleanedText = cleanedText.replace(/^```(?:json)?\n?/gm, '');
    cleanedText = cleanedText.replace(/\n?```$/gm, '');
    cleanedText = cleanedText.trim();

    console.log(`${result.provider} response (first 200 chars):`, cleanedText.substring(0, 200));
    return JSON.parse(cleanedText);
  }

  /**
   * Last-resort reconciliation: if extracted items still sum HIGHER than the
   * receipt total after the corrective retry, the model couldn't locate the
   * discount line on the receipt. Insert a synthetic discount line for the
   * difference so downstream math (line totals vs. receipt total) reconciles,
   * and drop the PRICE_MISMATCH issue. We only do this when the difference
   * looks like a plausible discount (sum > total, diff < 50% of sum) — never
   * when items sum LOWER than total, since that indicates missed items, not a
   * discount.
   */
  private reconcileWithSyntheticDiscount(receipt: ReceiptData): void {
    if (!receipt.items || receipt.items.length === 0) return;

    const calculatedTotal = receipt.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);
    const diff = calculatedTotal - receipt.total;

    if (diff <= 0.05) return;
    if (diff > calculatedTotal * 0.5) return;

    const syntheticDiscount: ReceiptItem = {
      description: 'Popust (rekonstruiran iz razlike total - vsota izdelkov)',
      quantity: 1,
      quantityUnit: 'pc',
      unitPrice: -Math.round(diff * 100) / 100,
      lineTotal: -Math.round(diff * 100) / 100,
      itemType: 'discount',
      discountMetadata: {
        type: 'fixed',
        value: Math.round(diff * 100) / 100,
      },
    };
    receipt.items.push(syntheticDiscount);

    if (receipt.validationIssues) {
      receipt.validationIssues = receipt.validationIssues.filter(
        (i) => i.type !== 'PRICE_MISMATCH'
      );
      if (receipt.validationIssues.length === 0) {
        delete receipt.validationIssues;
      }
    }

    console.log(
      `✓ Reconciled with synthetic discount of -${diff.toFixed(2)} (model could not locate discount line)`
    );
  }

  private computeLineTotals(receipt: ReceiptData): void {
    if (receipt.items) {
      for (const item of receipt.items) {
        item.lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
      }
    }
  }

  private buildCorrectionPrompt(ocrText: string | null, calculatedTotal: number, receiptTotal: number): string {
    const diff = calculatedTotal - receiptTotal;
    const absDiff = Math.abs(diff).toFixed(2);

    let directionalHint: string;
    if (diff > 0) {
      // Sum > total → likely missed a discount
      directionalHint = `The sum of your extracted items (${calculatedTotal.toFixed(2)}) is HIGHER than the receipt total (${receiptTotal.toFixed(2)}) by ${absDiff}.

This almost always means you MISSED A DISCOUNT line. Look very carefully for:
- Lines containing "Popust", "Rabatt", "Discount", "Sale", "Akcija", "-€", percentage values like "10%", or coupon codes
- Discount summaries near the bottom of the receipt (e.g., "Skupaj popust", "Total savings", "You saved")
- Loyalty card / member discounts
- Items where the printed price is crossed out and a lower price is shown
- A discount of approximately ${absDiff} should exist somewhere on the receipt

Add the missed discount(s) as separate items with itemType: "discount" and NEGATIVE unitPrice.
Do NOT change the unitPrice of existing products to make the math work — find the actual discount line.`;
    } else {
      // Sum < total → missing items or wrong prices
      directionalHint = `The sum of your extracted items (${calculatedTotal.toFixed(2)}) is LOWER than the receipt total (${receiptTotal.toFixed(2)}) by ${absDiff}.

You likely MISSED ITEMS or used wrong prices. Check:
1. Are all line items captured? Look for items at the top/bottom you may have skipped.
2. Are unitPrice values correct (per-unit price, NOT line total divided wrong)?
3. Are quantities correct for multi-line formats like "N KOS × price"?
4. Is there a fee/service charge/tip you missed?`;
    }

    return `Your previous extraction has a price mismatch.

${directionalHint}

${this.buildUserPrompt(ocrText)}`;
  }

  /**
   * Detects and corrects 90°/180°/270° rotation using Tesseract OSD before OCR.
   * Gracefully returns the original image if OSD fails or confidence is too low.
   *
   * OSD only recognises axis-aligned orientations (multiples of 90°). Fine-grained
   * tilt correction (< 45°) is already handled in ImageSplitterService at crop time.
   */
  private async correctRotation(image: Buffer): Promise<Buffer> {
    // Minimum OSD confidence to act on a detected rotation (empirically ~1-3 is
    // reliable; below this the detection is too noisy to trust).
    const MIN_CONFIDENCE = 0.3;

    try {
      const worker = await getOsdWorker();
      // Grayscale + normalize improve OSD confidence and 180° detection.
      // PNG conversion because Tesseract/Leptonica doesn't handle WebP reliably.
      const pngBuffer = await sharp(image).grayscale().normalize().png().toBuffer();
      const { data } = await worker.detect(pngBuffer);

      const degrees = data.orientation_degrees;
      const confidence = data.orientation_confidence ?? 0;

      if (degrees === null || degrees === 0 || confidence < MIN_CONFIDENCE) {
        return image;
      }

      // `orientation_degrees` is the clockwise rotation already applied to the
      // image. Rotating by the negative value restores upright orientation.
      const correction = (360 - degrees) % 360;
      console.log(`OSD: rotating image by ${correction}° to correct ${degrees}° orientation (confidence: ${confidence.toFixed(2)})`);

      return await sharp(image).rotate(correction).toBuffer();
    } catch (error) {
      console.warn('OSD rotation detection failed, continuing with original orientation:', error);
      return image;
    }
  }

  /**
   * Preprocesses an image for OCR: rotation correction + grayscale + contrast
   * normalization + sharpen. These steps significantly improve Cloud Vision text
   * detection on real-world receipt photos (uneven lighting, low contrast,
   * soft focus, sideways/upside-down captures).
   *
   * Controlled by `OCR_PREPROCESS` env var (defaults to enabled). Set to "false"
   * to bypass preprocessing and use the raw image — useful for A/B comparison
   * or when the original is already high quality.
   */
  private async preprocessForOcr(image: Buffer): Promise<Buffer> {
    if (process.env.OCR_PREPROCESS === 'false') {
      return image;
    }
    try {
      const oriented = await this.correctRotation(image);
      return await sharp(oriented)
        .rotate() // honor any remaining EXIF orientation
        .grayscale()
        .normalize() // stretch histogram → boost contrast
        .sharpen()
        .toBuffer();
    } catch (error) {
      console.warn('OCR image preprocessing failed, falling back to raw image:', error);
      return image;
    }
  }

  /**
   * Runs Tesseract.js OCR as a complementary engine. Tesseract uses a different
   * algorithm than Cloud Vision (LSTM + classical CV pipeline) so it can catch
   * text that Vision missed and vice versa. Lazy-loads the shared worker on
   * first use. Returns null on failure (graceful degradation).
   */
  private async extractTextWithTesseract(image: Buffer): Promise<string | null> {
    if (process.env.OCR_TESSERACT === 'false') {
      return null;
    }
    try {
      const worker = await getTesseractWorker();
      const result = await worker.recognize(image);
      const text = result.data.text?.trim() || null;
      if (text) {
        console.log(`Tesseract extracted ${text.length} characters of text.`);
      }
      return text;
    } catch (error) {
      console.warn('Tesseract OCR failed:', error);
      return null;
    }
  }

  /**
   * Extracts text from a receipt image using a multi-engine pipeline:
   *   1. Cloud Vision documentTextDetection (preprocessed image, with language hints)
   *   2. Cloud Vision textDetection retry (different segmentation algorithm)
   *   3. Tesseract.js (different engine entirely, may catch what Vision missed)
   *
   * The outputs of all engines are concatenated, deduplicated by line, so the
   * downstream OCR cross-validation can find numbers from any source. This is a
   * "consensus union" rather than "best engine wins" — more recall, slightly
   * less precision, which is the right trade-off for hallucination detection.
   */
  public async extractText(image: Buffer): Promise<string | null> {
    return this.extractTextWithVision(image);
  }

  public async extractTextDebug(image: Buffer, preprocess = true): Promise<{
    visionDocument: string | null;
    visionText: string | null;
    tesseract: string | null;
    merged: string | null;
    charCounts: { visionDocument: number; visionText: number; tesseract: number; merged: number };
  }> {
    const languageHints = ['sl', 'hr', 'en', 'de'];
    const processedImage = preprocess ? await this.preprocessForOcr(image) : image;

    const [documentResult, textResult, tesseractText] = await Promise.allSettled([
      this.visionClient.documentTextDetection({
        image: { content: processedImage },
        imageContext: { languageHints },
      }),
      this.visionClient.textDetection({
        image: { content: processedImage },
        imageContext: { languageHints },
      }),
      this.extractTextWithTesseract(processedImage),
    ]);

    const visionDocument = documentResult.status === 'fulfilled'
      ? (documentResult.value[0].fullTextAnnotation?.text ?? null)
      : null;

    const visionText = textResult.status === 'fulfilled'
      ? (textResult.value[0].textAnnotations?.[0]?.description ?? null)
      : null;

    const tesseract = tesseractText.status === 'fulfilled' ? tesseractText.value : null;

    const merged = this.mergeOcrTexts(visionDocument, visionText, tesseract);

    return {
      visionDocument,
      visionText,
      tesseract,
      merged,
      charCounts: {
        visionDocument: visionDocument?.length ?? 0,
        visionText: visionText?.length ?? 0,
        tesseract: tesseract?.length ?? 0,
        merged: merged?.length ?? 0,
      },
    };
  }

  private async extractTextWithVision(image: Buffer): Promise<string | null> {
    const languageHints = ['sl', 'hr', 'en', 'de'];
    const processedImage = await this.preprocessForOcr(image);
    let visionText: string | null = null;

    try {
      const [result] = await this.visionClient.documentTextDetection({
        image: { content: processedImage },
        imageContext: { languageHints },
      });
      visionText = result.fullTextAnnotation?.text ?? null;

      // Cloud Vision retry: če documentTextDetection vrne malo besedila, poskusi
      // še textDetection (drugačen algoritem segmentacije).
      if (!visionText || visionText.length < 100) {
        console.warn(
          `documentTextDetection returned only ${visionText?.length ?? 0} chars, retrying with textDetection...`,
        );
        const [retry] = await this.visionClient.textDetection({
          image: { content: processedImage },
          imageContext: { languageHints },
        });
        const retryText = retry.textAnnotations?.[0]?.description ?? null;
        if (retryText && retryText.length > (visionText?.length ?? 0)) {
          visionText = retryText;
        }
      }

      if (visionText) {
        console.log(`Cloud Vision extracted ${visionText.length} characters of text.`);
      }
    } catch (error) {
      console.warn('Cloud Vision OCR failed, falling back to other engines:', error);
    }

    // Always run Tesseract as a complementary engine (unless disabled). Its
    // output is merged with Cloud Vision's for the OCR cross-validation Set.
    const tesseractText = await this.extractTextWithTesseract(processedImage);

    return this.mergeOcrTexts(visionText, tesseractText);
  }

  /**
   * Merges OCR outputs from multiple engines into a single deduplicated text.
   * Lines are normalized (whitespace collapsed, lowercased for comparison) but
   * the original casing/spacing is preserved in the output. Both engines'
   * unique lines end up in the final string, separated by newlines.
   */
  private mergeOcrTexts(...sources: (string | null)[]): string | null {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const source of sources) {
      if (!source) continue;
      for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const key = line.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(line);
      }
    }
    return merged.length > 0 ? merged.join('\n') : null;
  }

  private buildSystemPrompt(): string {
    return `You are an expert receipt OCR and data extraction system. Your task is to analyze receipt images with EXTREME PRECISION.

      STEP 1: IMAGE QUALITY CHECK
      - If the image is too blurry, dark, or unreadable, return an empty JSON object: {}
      - Only proceed if you can confidently read all text

      STEP 2: UNDERSTAND THE RECEIPT LAYOUT
      Most receipts follow this pattern:
      [Item Description] [Quantity/Weight] [Unit Price] [Total Line Price]

      Example receipt line:
      Coca Cola 500ml    2 x €1.50    €3.00
      └─ Description ─┘  └Qty×Unit─┘  └Total─┘

      STEP 3: EXTRACT DATA WITH PRECISION

      CRITICAL RULES FOR PRICE EXTRACTION:
      ════════════════════════════════════
      1. Each PRODUCT results in exactly ONE item in the output - never duplicate items
      2. The 'unitPrice' field is the PRICE PER UNIT (per piece, per kg, etc.) — NOT the line total
      3. If a line has multiple numbers, identify which is:
         - Product code (usually near start, no currency symbol) - IGNORE
         - Quantity (small number like 1, 2, 3 or weight like 0.350)
         - Unit price (the price for ONE unit — THIS IS WHAT YOU EXTRACT as 'unitPrice')
         - Line total (rightmost column — DO NOT extract this; it will be computed in code)
      4. For items with quantity=1, the unit price and line total are the same — extract that number as 'unitPrice'
      5. Match each unit price to its description EXACTLY - do not mix up lines

      ████████████████████████████████████████████████████████████████████████
      ██  MULTI-LINE RECEIPT FORMAT (CRITICAL - SLOVENIAN/EUROPEAN STORES) ██
      ████████████████████████████████████████████████████████████████████████

      Many receipts (especially Hofer/Aldi, Mercator, Spar, Lidl in Slovenia) use a
      MULTI-LINE format where an item spans TWO lines:

      Line 1: Item name only (NO price on this line)
      Line 2: Quantity breakdown → "N KOS × unit_price" or "N × unit_price" followed by line total

      EXAMPLE (Slovenian Hofer receipt):
      ─────────────────────────────────────────
      Pasirani paradižnik 500g
        4 KOS × 0,57                     2,28
      Piščančja posebna klobasa IK 400g
        3 KOS × 0,84                     2,52
      Zelje
        1,688 kg × 0,93                  1,57
      ─────────────────────────────────────────

      CORRECT extraction:
      → { description: "Pasirani paradižnik 500g", quantity: 4, quantityUnit: "pc", unitPrice: 0.57 }
      → { description: "Piščančja posebna klobasa IK 400g", quantity: 3, quantityUnit: "pc", unitPrice: 0.84 }
      → { description: "Zelje", quantity: 1.688, quantityUnit: "kg", unitPrice: 0.93 }

      WRONG (DO NOT DO THIS):
      ✗ Creating 4 separate items for "Pasirani paradižnik 500g" at €0.57 each
      ✗ Using the line total (2.28) instead of the unit price (0.57) for 'unitPrice'
      ✗ Treating the quantity breakdown line as a separate item

      KEY RECOGNITION PATTERNS for multi-line items:
      - "N KOS ×" or "N KOS x" (KOS = pieces in Slovenian)
      - "N × price" on an indented line below an item name
      - "N,NNN kg × price" for weighed items
      - The line total appears at the END of the quantity breakdown line
      - If you see the SAME item name repeated multiple times, you are likely
        misreading a multi-line format. STOP and re-examine the receipt layout.

      VISUAL ALIGNMENT EXAMPLE:
      ─────────────────────────────────────────
      Description             Qty    UnitPrice
      ─────────────────────────────────────────
      Milk 1L                 1      €2.50  ← Extract unitPrice=2.50
      Bread                   2      €1.50  ← Extract unitPrice=1.50
      Banana (kg)             0.5    €2.50  ← Extract unitPrice=2.50
      ─────────────────────────────────────────

      COMMON RECEIPT FORMATS TO HANDLE:

      Format 1: Simple (Description + Price on same line)
      Milk 1L                €2.50
      → Extract: description="Milk 1L", quantity=1, unitPrice=2.50

      Format 2: With Quantity on same line
      Milk 1L    2x €1.25    €2.50
      → Extract: description="Milk 1L", quantity=2, unitPrice=1.25 (the per-unit price, NOT the line total!)

      Format 3: Multi-line with quantity breakdown (COMMON IN SLOVENIAN STORES)
      Pasirani paradižnik 500g
        4 KOS × 0,57         2,28
      → Extract: description="Pasirani paradižnik 500g", quantity=4, unitPrice=0.57
      → This is ONE item, NOT four separate items!

      Format 4: Weight-based
      Banana                 0.350 kg  €1.99/kg  €0.70
      → Extract: description="Banana", quantity=0.350, quantityUnit="kg", unitPrice=1.99 (the per-kg price!)

      Format 5: Multi-line weight-based
      Zelje
        1,688 kg × 0,93      1,57
      → Extract: description="Zelje", quantity=1.688, quantityUnit="kg", unitPrice=0.93

      Format 6: Compact (numbers close together)
      Coca Cola 500ml  2  1.50  3.00
      → Extract: description="Coca Cola 500ml", quantity=2, unitPrice=1.50 (the per-unit price!)

      IMPORTANT VALIDATION:
      - After extracting all items, compute each line total as quantity × unitPrice and sum them
      - The sum should equal the receipt TOTAL (not subtotal - item prices include tax)
      - If your sum is off by more than €0.50, YOU MADE A MISTAKE - go back and review:
        1. Are you extracting the correct per-unit price for 'unitPrice'?
        2. Are you creating duplicate items from multi-line quantity breakdowns?
        3. If the same item name appears multiple times, is it genuinely bought separately
           or is it a multi-line format showing "N × unit_price = total"?
      - The number of output items should match the number of DISTINCT purchased products,
        not the number of physical lines on the receipt

      WHAT TO IGNORE:
      - Product codes (e.g., "12345", "SKU-987")
      - Barcodes
      - Item numbers
      - Department codes
      - Running subtotals mid-receipt

      ITEM TYPE CLASSIFICATION:
      Each line item must have an "itemType" field that identifies what kind of item it is:

      - "product" - Regular purchased items (bread, milk, clothes, electronics, etc.)
      - "discount" - Price reductions, sales, coupons, loyalty discounts
      - "tax" - Tax lines (VAT, sales tax, etc.)
      - "tip" - Gratuity/tips
      - "fee" - Service fees, delivery fees, processing fees
      - "refund" - Returns or refunds
      - "adjustment" - Other price adjustments

      DISCOUNTS - IMPORTANT:
      When you see discount lines (e.g., "Popust 10%", "DISCOUNT -€2.00", "Rabatt", "Sale"), you MUST:
      1. Set itemType: "discount"
      2. Use negative unitPrice: unitPrice=-2.00 (discounts are always negative)
      3. Include discount metadata:
         - If percentage discount (e.g., "10% off"):
           discountMetadata: { type: "percentage", value: 10 }
         - If fixed amount discount (e.g., "-€15"):
           discountMetadata: { type: "fixed", value: 15 }
         - If coupon/promo code is visible (e.g., "HSC Welcome", "SUMMER20"):
           discountMetadata: { type: "coupon", code: "HSC_WELCOME", value: 15 }

      IMPORTANT: Slovenian receipts often use "Popust" for discounts - always mark these as itemType: "discount"
      - For 'quantityUnit', follow this CRITICAL logic:
        * FIRST: Check if the item description already contains a size/weight/volume (e.g., "500g", "1L", "250ml", "1.5kg", "330ml")
          → If YES: Use 'pc' (pieces) as the unit, because the size is part of the product identity
          → Examples:
            - "Coca Cola 500ml" → quantity: 2, quantityUnit: "pc" (bought 2 bottles)
            - "Sončnična margarina 500g" → quantity: 1, quantityUnit: "pc" (bought 1 package)
            - "Mleko 1L" → quantity: 3, quantityUnit: "pc" (bought 3 cartons)
        * SECOND: If the description does NOT contain a size, the item is sold by measurement:
          → Use the actual measurement unit: 'kg', 'g', 'L', 'ml', 'lb', 'oz'
          → Examples:
            - "Pasirani paradižnik" → quantity: 0.350, quantityUnit: "kg" (weighed at checkout)
            - "Banana" → quantity: 1.250, quantityUnit: "kg" (sold by weight)
            - "Fresh tomatoes" → quantity: 0.5, quantityUnit: "kg" (bulk/self-serve)
        * Common patterns that indicate packaged items: "500g", "1L", "250ml", "1.5kg", "330ml", "750ml", "2L", "100g"
      - For 'keywords' at the root level, provide general categories for the overall purchase (e.g., "groceries", "electronics", "dinner").
      - For 'keywords' at the item level, provide 2-3 descriptive keywords for the item (e.g., ["milk", "dairy"] or ["cola", "soft drink"]).
      - For 'category' and 'subcategory' at the item level, assign from this list:
      ${buildCategoryPromptList()}
        Set 'category' to the main category id (e.g., "dairy-eggs") and 'subcategory' to the most specific matching subcategory id (e.g., "cheese"). If no subcategory fits, set subcategory to null. For discounts/tax/fee items, omit category.
      - If a value is not present, use null where allowed (subtotal, tax, quantityUnit).
      - Ensure all monetary values are numbers, not strings.
      - Include package sizes in the description when visible on the receipt (e.g., write "Coca Cola 500ml" not just "Coca Cola").

      DATE FORMAT - CRITICAL:
      - Output transactionDate as ISO "YYYY-MM-DD".
      - Receipts in this system are almost exclusively European (Slovenian, German, Austrian, Italian, Croatian).
      - European date format is DAY.MONTH.YEAR (DD.MM.YYYY or D.M.YYYY), NOT month-first.
      - Examples of correct conversion:
        * "5.2.2026"   → "2026-02-05" (5th of February 2026)
        * "5. 2. 2026" → "2026-02-05"
        * "05/02/2026" → "2026-02-05" (5th of February — NOT May 2nd)
        * "31.12.2025" → "2025-12-31"
        * "1.1.2026"   → "2026-01-01"
      - NEVER assume US-style MM/DD/YYYY unless the receipt is clearly from the USA.
      - If the first number is > 12, it MUST be the day (e.g., "13.4.2026" can only be 13 April).
      - If the day is unambiguous from context (the receipt is in Slovenian/German/Italian/Croatian), use DD.MM.YYYY interpretation.

      REQUIRED JSON STRUCTURE:
      {
        "merchantName": "Store Name",
        "transactionDate": "YYYY-MM-DD",
        "transactionTime": "HH:MM:SS",
        "items": [
          {
            "description": "Item name with package size if visible",
            "quantity": 1.5,
            "quantityUnit": "pc" or "kg" or "g" or "L" or "ml",
            "unitPrice": 8.66,
            "keywords": ["keyword1", "keyword2"],
            "category": "category-id",
            "subcategory": "subcategory-id",
            "itemType": "product" or "discount" or "tax" or "tip" or "fee",
            "discountMetadata": {
              "type": "percentage" or "fixed" or "coupon",
              "value": 10,
              "code": "PROMO_CODE"
            }
          }
        ],
        "subtotal": 50.00,
        "tax": 10.00,
        "total": 60.00,
        "currency": "EUR",
        "keywords": ["groceries"]
      }

      COMPLETE EXTRACTION EXAMPLE:

      Receipt shows:
      ─────────────────────────────────────
      HERVIS Sports
      2026-01-07  15:45:00

      HLACE M MARIO XL           €259.99
      Popust (10%)              -€26.00
      SMUČARSKA JAKNA M Bally   €114.99
      Popust (HSC Welcome)       -€15.00

      SUBTOTAL                  €333.98
      TAX (22%)                  €73.48
      TOTAL                     €407.46
      ─────────────────────────────────────

      Your JSON output:
      {
        "merchantName": "HERVIS Sports",
        "transactionDate": "2026-01-07",
        "transactionTime": "15:45:00",
        "items": [
          {
            "description": "HLACE M MARIO XL",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": 259.99,
            "keywords": ["pants", "clothing"],
            "category": "clothing",
            "subcategory": "clothes",
            "itemType": "product"
          },
          {
            "description": "Popust (10%)",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": -26.00,
            "keywords": ["discount"],
            "itemType": "discount",
            "discountMetadata": {
              "type": "percentage",
              "value": 10
            }
          },
          {
            "description": "SMUČARSKA JAKNA M Bally",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": 114.99,
            "keywords": ["ski jacket", "outerwear"],
            "category": "sports-outdoors",
            "subcategory": "outdoor-gear",
            "itemType": "product"
          },
          {
            "description": "Popust (HSC Welcome)",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": -15.00,
            "keywords": ["discount"],
            "itemType": "discount",
            "discountMetadata": {
              "type": "coupon",
              "code": "HSC_WELCOME",
              "value": 15
            }
          }
        ],
        "subtotal": 333.98,
        "tax": 73.48,
        "total": 407.46,
        "currency": "EUR",
        "keywords": ["sports equipment", "clothing", "shopping"],
        "confidenceScores": {
          "merchantName": 95,
          "transactionDate": 90,
          "total": 98,
          "items": 85
        }
      }

      CONFIDENCE SCORES:
      For each extraction, provide confidence scores (0-100) indicating how certain you are:
      - "merchantName": How confident you are in the store name (100 = clearly visible, 50 = partially readable)
      - "transactionDate": How confident you are in the date (100 = clearly printed, 50 = partially visible or ambiguous format)
      - "total": How confident you are in the total amount (100 = clearly visible, 50 = partially readable)
      - "items": Overall confidence in item extraction accuracy (100 = all items clearly readable, 50 = some items uncertain)
      Each item also has a "confidence" field (0-100) for that specific item's extraction accuracy.

      FINAL INSTRUCTION:
      Return ONLY the JSON object. No markdown, no explanation, no code fences. Just pure JSON.
    `;
  }

  private buildUserPrompt(ocrText: string | null): string {
    if (ocrText) {
      return `Analyze the following receipt. Use the OCR text as the PRIMARY source for all numeric values (prices, quantities, totals). Use the image for understanding layout, structure, and any values the OCR may have missed.

=== OCR TEXT FROM RECEIPT ===
${ocrText}
=== END OCR TEXT ===

Extract all data from this receipt into the required JSON structure.`;
    }

    return 'Analyze the receipt in the image and extract all data into the required JSON structure.';
  }

  /**
   * Validates that the extracted prices make sense and returns validation issues.
   */
  private validatePrices(receipt: ReceiptData): void {
    const issues: ValidationIssue[] = [];
    
    try {
      // Calculate sum of all item line totals
      const calculatedTotal = receipt.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);
      
      // Check if the sum of item prices matches the total (not subtotal - item prices usually include VAT)
      const diff = Math.abs(calculatedTotal - receipt.total);
      if (diff > 0.05) {
        const issue: ValidationIssue = {
          severity: 'warning',
          type: 'PRICE_MISMATCH',
          message: `Sum of item prices (${calculatedTotal.toFixed(2)}) differs from receipt total (${receipt.total.toFixed(2)}) by ${diff.toFixed(2)}`,
          details: {
            calculatedSubtotal: calculatedTotal.toFixed(2),
            receiptSubtotal: receipt.total.toFixed(2),
            difference: diff.toFixed(2),
            items: receipt.items.map(i => ({ description: i.description, lineTotal: i.lineTotal })),
          },
        };
        issues.push(issue);
        console.warn(`⚠️  Price validation warning: ${issue.message}`);
      }
      
      // NOTE: We deliberately do NOT cross-check `subtotal + tax ≈ total`.
      // Across receipt formats `subtotal` and `tax` mean different things
      // (net vs gross, pre- vs post-discount, included vs additive VAT) and
      // building per-format formulas does not scale. The PRICE_MISMATCH check
      // above is the universal source of truth: if line items sum to the
      // receipt total, the extraction is internally consistent regardless of
      // how subtotal/tax are interpreted on this particular receipt.


      // Check for unrealistic or invalid prices
      receipt.items.forEach((item, index) => {
        const lt = item.lineTotal ?? 0;
        const itemType = item.itemType || (lt < 0 ? 'discount' : 'product');

        if (lt === 0) {
          const issue: ValidationIssue = {
            severity: 'error',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" has a line total of zero.`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }

        if (lt < 0 && itemType === 'product') {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" has a negative line total (${lt}) but is marked as a product. Should be marked as discount/refund.`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }

        if ((itemType === 'discount' || itemType === 'refund') && lt > 0) {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" is marked as ${itemType} but has a positive line total (${lt}). Discounts should be negative.`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }

        if (itemType === 'product' && lt > 10000) {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'UNREALISTIC_PRICE',
            message: `Item "${item.description}" has an unusually high line total: ${lt}`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }
      });
      
      // Validate date plausibility — only flag future dates. Receipts can
      // legitimately be older than 1 year (archived purchases, late uploads,
      // historical data), so we don't bound the past.
      if (receipt.transactionDate) {
        const txDate = new Date(receipt.transactionDate);
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (txDate > tomorrow) {
          issues.push({
            severity: 'warning',
            type: 'INVALID_DATE',
            message: `Transaction date "${receipt.transactionDate}" is in the future.`,
            details: { transactionDate: receipt.transactionDate },
          });
        }
      }

      // Validate quantities
      receipt.items.forEach((item, index) => {
        if (item.itemType === 'product' && item.quantity > 100) {
          issues.push({
            severity: 'warning',
            type: 'UNREALISTIC_QUANTITY',
            message: `Item "${item.description}" has an unusually high quantity: ${item.quantity}`,
            details: { itemIndex: index, description: item.description, quantity: item.quantity },
          });
        }
      });

      // Validate merchant name
      if (!receipt.merchantName || receipt.merchantName.trim() === '') {
        issues.push({
          severity: 'warning',
          type: 'MISSING_MERCHANT',
          message: 'Merchant name is empty or missing.',
        });
      }

      // Validate negative total without refund/discount items
      if (receipt.total < 0) {
        const hasRefundOrDiscount = receipt.items.some(
          (i) => i.itemType === 'refund' || i.itemType === 'discount'
        );
        if (!hasRefundOrDiscount) {
          issues.push({
            severity: 'warning',
            type: 'INVALID_PRICE',
            message: `Receipt total is negative (${receipt.total}) but no refund/discount items found.`,
            details: { total: receipt.total },
          });
        }
      }

      // Attach validation issues to the receipt
      if (issues.length > 0) {
        receipt.validationIssues = issues;
      }

    } catch (error) {
      console.error('Error during price validation:', error);
      // Don't throw - validation is best-effort
    }
  }

  /**
   * Cross-validates extracted values against raw OCR text to detect potential AI hallucinations.
   * Checks that key numeric values (total, item prices) actually appear in the OCR output.
   *
   * Implementation: extracts ALL numbers from the OCR text into a Set of canonical
   * "X.XX" strings (handling EU 1.234,56 and US 1,234.56 conventions), then performs
   * exact-match lookups. This avoids substring false positives/negatives that the
   * previous String.includes() approach suffered from.
   */
  private crossValidateWithOCR(receipt: ReceiptData, ocrText: string): void {
    const numbers = this.extractOcrNumbers(ocrText);

    // Epsilon-based comparison handles:
    //  - rounding ambiguity (1.485 → 1.48 vs 1.49 in toFixed(2))
    //  - 3-decimal fuel prices (€1.485/L) where receipt model returns 1.485
    //  - small OCR misreads at the cent level
    const checkNumber = (value: number): boolean => {
      if (value === 0) return true;
      const target = Math.abs(value);
      return numbers.some((n) => Math.abs(n - target) < 0.01);
    };

    // First pass: collect all individual mismatches without committing them
    const candidateIssues: ValidationIssue[] = [];
    const totalMismatched = !checkNumber(receipt.total);

    if (totalMismatched) {
      candidateIssues.push({
        severity: 'warning',
        type: 'OCR_MISMATCH',
        message: `Receipt total (${receipt.total}) not found in OCR text — possible hallucination.`,
        details: { field: 'total', value: receipt.total },
      });
    }

    const productItems = receipt.items.filter((it) => it.itemType === 'product');
    let mismatchedItemCount = 0;

    productItems.forEach((item) => {
      const index = receipt.items.indexOf(item);
      if (!checkNumber(item.unitPrice)) {
        mismatchedItemCount++;
        const ctx = this.ocrContextAround(ocrText, item.description);
        candidateIssues.push({
          severity: 'warning',
          type: 'OCR_MISMATCH',
          message: `Item "${item.description}" unitPrice (${item.unitPrice}) not found in OCR text.`,
          details: {
            field: 'unitPrice',
            itemIndex: index,
            description: item.description,
            value: item.unitPrice,
            ocrContext: ctx,
          },
        });
      }
    });

    // Heuristic: if OCR clearly failed on most of the receipt (≥50% of products
    // missing AND total also missing, OR ≥80% of products missing), the image
    // is too low-quality for reliable OCR cross-validation. Suppress the noisy
    // per-item warnings and emit ONE LOW_IMAGE_QUALITY flag instead — this lets
    // the UI surface a "needs manual review" badge without spamming the user.
    //
    // We require at least 3 products before applying ratio-based suppression:
    // a 1/1 or 1/2 mismatch is statistically meaningless and is more likely a
    // single OCR fusion glitch than systemic OCR blindness.
    const productCount = productItems.length;
    const mismatchRatio = productCount > 0 ? mismatchedItemCount / productCount : 0;
    const MIN_ITEMS_FOR_RATIO = 3;
    const ocrUnreliable =
      productCount >= MIN_ITEMS_FOR_RATIO &&
      ((totalMismatched && mismatchRatio >= 0.5) || mismatchRatio >= 0.8);

    if (ocrUnreliable) {
      const flag: ValidationIssue = {
        severity: 'warning',
        type: 'LOW_IMAGE_QUALITY',
        message: `Image quality too low for OCR cross-validation — ${mismatchedItemCount}/${productCount} item prices${totalMismatched ? ' and the total' : ''} could not be verified against OCR text. Receipt data is from vision model only and may need manual review.`,
        details: {
          mismatchedItems: mismatchedItemCount,
          totalItems: productCount,
          totalMismatched,
          ocrCharCount: ocrText.length,
        },
      };
      receipt.validationIssues = [...(receipt.validationIssues ?? []), flag];
      console.warn(
        `⚠️  LOW_IMAGE_QUALITY: OCR unreliable (${mismatchedItemCount}/${productCount} items missing, total ${totalMismatched ? 'also missing' : 'OK'}). Suppressing per-item OCR warnings.`,
      );
      return;
    }

    if (candidateIssues.length > 0) {
      receipt.validationIssues = [...(receipt.validationIssues ?? []), ...candidateIssues];
      for (const issue of candidateIssues) {
        const ctx = issue.details?.ocrContext;
        console.warn(`⚠️  ${issue.message}${ctx ? ` Context: "${ctx}"` : ''}`);
      }
      console.warn(`⚠️  OCR cross-validation: ${candidateIssues.length} mismatch(es) detected`);
    }
  }

  /**
   * Extracts all numbers from OCR text. Handles EU (1.234,56) and US (1,234.56)
   * thousands/decimal conventions, stitches numbers split by stray whitespace
   * ("69, 99" → "69,99"), and supports up to 3-decimal precision (e.g. fuel
   * prices like €1.485/L). Ambiguous tokens are added in BOTH interpretations
   * to maximize recall.
   */
  private extractOcrNumbers(ocrText: string): number[] {
    const numbers: number[] = [];
    const compacted = ocrText.replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3');
    const numberRegex = /\d{1,3}(?:[.,]\d{3})*[.,]\d{1,4}|\d+[.,]\d{1,4}|\d{1,7}/g;
    for (const match of compacted.matchAll(numberRegex)) {
      for (const value of this.normalizeOcrNumber(match[0])) {
        numbers.push(value);
      }
    }
    return numbers;
  }

  /**
   * Canonicalizes a raw number token into one or more numeric interpretations.
   * Returns multiple values when the token is ambiguous (e.g. "1.485" could be
   * 1485 with thousands grouping OR 1.485 as a 3-decimal price).
   */
  private normalizeOcrNumber(raw: string): number[] {
    const cleaned = raw.replace(/\s/g, '');
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    const results: number[] = [];

    const pushParsed = (intPart: string, decPart: string) => {
      const num = parseFloat(`${intPart || '0'}.${decPart || '0'}`);
      if (!isNaN(num)) results.push(num);
    };

    if (lastDot > -1 && lastComma > -1) {
      // Both separators present — the LAST one is unambiguously the decimal
      if (lastDot > lastComma) {
        pushParsed(
          cleaned.substring(0, lastDot).replace(/,/g, ''),
          cleaned.substring(lastDot + 1),
        );
      } else {
        pushParsed(
          cleaned.substring(0, lastComma).replace(/\./g, ''),
          cleaned.substring(lastComma + 1),
        );
      }
    } else if (lastDot > -1 || lastComma > -1) {
      const idx = lastDot > -1 ? lastDot : lastComma;
      const sep = lastDot > -1 ? '.' : ',';
      const tail = cleaned.substring(idx + 1);
      const head = cleaned.substring(0, idx);

      if (tail.length <= 3) {
        // Decimal interpretation (covers 2-decimal cents and 3-decimal fuel/per-kg prices)
        pushParsed(head, tail);
      }
      // If tail is exactly 3 digits, it MIGHT also be thousands grouping ("1.069" = 1069).
      // Add both interpretations so we don't miss matches in either direction.
      if (tail.length === 3) {
        pushParsed(head + tail, '0');
      }
      if (tail.length > 3) {
        // Definitely not a decimal — collapse as thousands grouping
        pushParsed(cleaned.split(sep).join(''), '0');
      }
    } else {
      pushParsed(cleaned, '0');
    }

    return results;
  }

  /** Returns up to ~160 chars of OCR text around the first match of `needle`. */
  private ocrContextAround(ocrText: string, needle: string): string {
    const idx = ocrText.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) return '(description not found in OCR)';
    const start = Math.max(0, idx - 80);
    const end = Math.min(ocrText.length, idx + needle.length + 80);
    return ocrText.substring(start, end).replace(/\s+/g, ' ');
  }
}