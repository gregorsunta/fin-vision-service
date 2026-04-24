import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { lineItems, processingErrors, receipts } from '../../db/schema.js';
import type {
  ReceiptData,
  ReceiptItem,
  ExtractionFlag,
  ExtractionFlagReason,
} from '../../services/receipt-analysis.js';

/**
 * Majority vote over item categories, excluding discount/tax rows which would
 * bias the result. Returns null if no categorized items remain.
 */
export function deriveReceiptCategory(items: ReceiptItem[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.category && item.itemType !== 'discount' && item.itemType !== 'tax') {
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best = '';
  let bestCount = 0;
  for (const [cat, count] of counts) {
    if (count > bestCount) {
      best = cat;
      bestCount = count;
    }
  }
  return best;
}

function buildItemExtractionFlag(item: ReceiptItem): ExtractionFlag | null {
  if (item._ocrMismatch) {
    return { source: 'ocr_mismatch', reason: 'not_in_ocr', detail: 'Value not found in OCR text' };
  }
  if (item.extractionFlag) {
    return { source: 'llm_uncertain', reason: item.extractionFlag as ExtractionFlagReason };
  }
  if (item.confidence !== undefined && item.confidence < 70) {
    return { source: 'low_confidence', reason: 'text_unclear', detail: `AI confidence: ${Math.round(item.confidence)}%` };
  }
  return null;
}

function buildFieldWarnings(
  data: ReceiptData,
): Array<ExtractionFlag & { field: string }> | undefined {
  const warnings: Array<ExtractionFlag & { field: string }> = [];

  for (const w of data.extractionWarnings ?? []) {
    warnings.push({ field: w.field, source: 'llm_uncertain', reason: w.reason as ExtractionFlagReason, detail: w.detail });
  }

  const cs = data.confidenceScores;
  if (cs) {
    const headerFields: Array<[keyof typeof cs, string]> = [
      ['merchantName', 'storeName'],
      ['transactionDate', 'transactionDate'],
      ['total', 'totalAmount'],
    ];
    for (const [key, dbField] of headerFields) {
      if (cs[key] < 70 && !warnings.some((w) => w.field === dbField)) {
        warnings.push({ field: dbField, source: 'low_confidence', reason: 'text_unclear', detail: `Confidence: ${cs[key]}%` });
      }
    }
  }

  return warnings.length > 0 ? warnings : undefined;
}

/**
 * Persists AI extraction results into receipts + line_items + processing_errors
 * (for validation warnings). The receipt's reviewStatus becomes `needs_review`
 * if the analysis produced any validation issues, else `not_required`.
 */
export async function saveExtractedData(
  dbConn: typeof db,
  extractedData: ReceiptData,
  receiptId: number,
  uploadId: number,
  receiptCategory: string | null,
): Promise<void> {
  const hasWarnings = !!(extractedData.validationIssues && extractedData.validationIssues.length > 0);

  await dbConn
    .update(receipts)
    .set({
      status: 'processed',
      reviewStatus: hasWarnings ? 'needs_review' : 'not_required',
      storeName: extractedData.merchantName,
      totalAmount: extractedData.total.toString(),
      taxAmount: extractedData.tax?.toString(),
      transactionDate: new Date(
        `${extractedData.transactionDate}T${extractedData.transactionTime || '00:00:00'}`,
      ),
      currency: extractedData.currency || 'USD',
      keywords: extractedData.keywords,
      category: receiptCategory,
      ocrText: extractedData.ocrText ?? null,
      processingMetadata: {
        ...extractedData.processingMetadata,
        fieldWarnings: buildFieldWarnings(extractedData),
      } as typeof receipts.$inferInsert['processingMetadata'],
      confidenceScores: extractedData.confidenceScores ?? null,
    })
    .where(eq(receipts.id, receiptId));

  if (extractedData.items && extractedData.items.length > 0) {
    await dbConn.insert(lineItems).values(
      extractedData.items.map((item) => ({
        receiptId,
        description: item.description,
        amount: item.quantity.toString(),
        unit: item.quantityUnit || 'pc',
        pricePerUnit: item.unitPrice.toString(),
        discountPerUnit: item.discountPerUnit != null ? String(item.discountPerUnit) : null,
        unitPriceExVat: item.unitPriceExVat != null ? String(item.unitPriceExVat) : null,
        totalPrice: (item.lineTotal ?? 0).toString(),
        keywords: item.keywords,
        category: item.category || null,
        subcategory: item.subcategory || null,
        itemType: item.itemType || ((item.lineTotal ?? 0) < 0 ? 'discount' : 'product'),
        discountMetadata: item.discountMetadata || null,
        parentLineItemId: null,
        confidence: item.confidence?.toString() ?? null,
        extractionFlags: buildItemExtractionFlag(item),
      })),
    );
  }

  if (extractedData.validationIssues && extractedData.validationIssues.length > 0) {
    for (const issue of extractedData.validationIssues) {
      await dbConn.insert(processingErrors).values({
        uploadId,
        receiptId,
        category: 'VALIDATION_WARNING',
        message: `${issue.type}: ${issue.message}`,
        metadata: {
          severity: issue.severity,
          type: issue.type,
          details: issue.details,
        },
      });
    }
  }
}
