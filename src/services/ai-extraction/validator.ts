import { createLogger } from '../../utils/logger.js';
import type { ReceiptData, ValidationIssue } from './schema.js';

const log = createLogger('services.ai-extraction.validator');

/**
 * Validates extracted receipt data in-place, attaching issues to
 * `receipt.validationIssues`. Does not throw — validation is best-effort.
 *
 * Checks: price mismatch, invalid/unrealistic prices, future date (with
 * EU date-swap auto-correction), unrealistic quantities, missing merchant,
 * negative total without refund items.
 *
 * The date-swap heuristic silently corrects DD.MM → MM.DD when a future date
 * can be explained by swapping month and day (EU receipts only). Do not
 * remove this without testing on Slovenian/Austrian store receipts.
 */
export function validatePrices(receipt: ReceiptData): void {
  const issues: ValidationIssue[] = [];

  try {
    const calculatedTotal = receipt.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);
    const diff = Math.abs(calculatedTotal - receipt.total);
    if (diff > 0.05) {
      issues.push({
        severity: 'warning',
        type: 'PRICE_MISMATCH',
        message: `Sum of item prices (${calculatedTotal.toFixed(2)}) differs from receipt total (${receipt.total.toFixed(2)}) by ${diff.toFixed(2)}`,
        details: {
          calculatedSubtotal: calculatedTotal.toFixed(2),
          receiptSubtotal: receipt.total.toFixed(2),
          difference: diff.toFixed(2),
          items: receipt.items.map((i) => ({ description: i.description, lineTotal: i.lineTotal })),
        },
      });
      log.warn({ diff: diff.toFixed(2) }, 'price validation warning: PRICE_MISMATCH');
    }

    receipt.items.forEach((item, index) => {
      const lt = item.lineTotal ?? 0;
      const itemType = item.itemType || (lt < 0 ? 'discount' : 'product');

      if (lt === 0) {
        issues.push({
          severity: 'error',
          type: 'INVALID_PRICE',
          message: `Item "${item.description}" has a line total of zero.`,
          details: { itemIndex: index, description: item.description, unitPrice: item.unitPrice, lineTotal: lt, itemType },
        });
      }

      if (lt < 0 && itemType === 'product') {
        issues.push({
          severity: 'warning',
          type: 'INVALID_PRICE',
          message: `Item "${item.description}" has a negative line total (${lt}) but is marked as a product. Should be marked as discount/refund.`,
          details: { itemIndex: index, description: item.description, unitPrice: item.unitPrice, lineTotal: lt, itemType },
        });
      }

      if ((itemType === 'discount' || itemType === 'refund') && lt > 0) {
        issues.push({
          severity: 'warning',
          type: 'INVALID_PRICE',
          message: `Item "${item.description}" is marked as ${itemType} but has a positive line total (${lt}). Discounts should be negative.`,
          details: { itemIndex: index, description: item.description, unitPrice: item.unitPrice, lineTotal: lt, itemType },
        });
      }

      if (itemType === 'product' && lt > 10000) {
        issues.push({
          severity: 'warning',
          type: 'UNREALISTIC_PRICE',
          message: `Item "${item.description}" has an unusually high line total: ${lt}`,
          details: { itemIndex: index, description: item.description, unitPrice: item.unitPrice, lineTotal: lt, itemType },
        });
      }
    });

    if (receipt.transactionDate) {
      const txDate = new Date(receipt.transactionDate);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      if (txDate > tomorrow) {
        // Try swapping month and day (EU DD.MM.YYYY misread as MM.DD.YYYY).
        // Skip for US receipts — MM/DD is correct there.
        const parts = receipt.region !== 'us'
          ? receipt.transactionDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
          : null;
        if (parts) {
          const swapped = `${parts[1]}-${parts[3]}-${parts[2]}`;
          const swappedDate = new Date(swapped);
          if (!isNaN(swappedDate.getTime()) && swappedDate <= tomorrow) {
            log.warn(
              { original: receipt.transactionDate, swapped },
              'date is future, month/day likely swapped (European DD.MM), auto-correcting',
            );
            receipt.transactionDate = swapped;
          } else {
            issues.push({
              severity: 'warning',
              type: 'INVALID_DATE',
              message: `Transaction date "${receipt.transactionDate}" is in the future.`,
              details: { transactionDate: receipt.transactionDate },
            });
          }
        } else {
          issues.push({
            severity: 'warning',
            type: 'INVALID_DATE',
            message: `Transaction date "${receipt.transactionDate}" is in the future.`,
            details: { transactionDate: receipt.transactionDate },
          });
        }
      }
    }

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

    if (!receipt.merchantName || receipt.merchantName.trim() === '') {
      issues.push({
        severity: 'warning',
        type: 'MISSING_MERCHANT',
        message: 'Merchant name is empty or missing.',
      });
    }

    if (receipt.total < 0) {
      const hasRefundOrDiscount = receipt.items.some(
        (i) => i.itemType === 'refund' || i.itemType === 'discount',
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

    if (issues.length > 0) {
      receipt.validationIssues = issues;
    }
  } catch (error) {
    log.error({ err: error }, 'error during price validation');
  }
}

/**
 * Cross-validates extracted values against raw OCR text to detect potential
 * AI hallucinations. Numbers are extracted from OCR text and compared with
 * epsilon tolerance (handles EU vs US decimal conventions, rounding, fuel prices).
 *
 * When OCR is globally unreliable (≥50% of products + total missing, or ≥80%
 * of products missing), emits one LOW_IMAGE_QUALITY flag instead of noisy
 * per-item warnings.
 */
export function crossValidateWithOCR(receipt: ReceiptData, ocrText: string): void {
  const numbers = extractOcrNumbers(ocrText);

  const checkNumber = (value: number): boolean => {
    if (value === 0) return true;
    const target = Math.abs(value);
    return numbers.some((n) => Math.abs(n - target) < 0.01);
  };

  const candidateIssues: ValidationIssue[] = [];
  const totalMismatched = !checkNumber(receipt.total);

  if (totalMismatched) {
    candidateIssues.push({
      severity: 'warning',
      type: 'OCR_MISMATCH',
      message: `Receipt total (${receipt.total}) not found in OCR text — possible hallucination.`,
      details: { field: 'total', value: receipt.total },
    });
    receipt.extractionWarnings = [
      ...(receipt.extractionWarnings ?? []),
      { field: 'total', reason: 'not_in_ocr', detail: `Total ${receipt.total} not found in OCR text` },
    ];
  }

  const productItems = receipt.items.filter((it) => it.itemType === 'product');
  let mismatchedItemCount = 0;

  productItems.forEach((item) => {
    const index = receipt.items.indexOf(item);
    if (!checkNumber(item.unitPrice)) {
      mismatchedItemCount++;
      item._ocrMismatch = true;
      const ctx = ocrContextAround(ocrText, item.description);
      candidateIssues.push({
        severity: 'warning',
        type: 'OCR_MISMATCH',
        message: `Item "${item.description}" unitPrice (${item.unitPrice}) not found in OCR text.`,
        details: { field: 'unitPrice', itemIndex: index, description: item.description, value: item.unitPrice, ocrContext: ctx },
      });
    }
  });

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
      details: { mismatchedItems: mismatchedItemCount, totalItems: productCount, totalMismatched, ocrCharCount: ocrText.length },
    };
    receipt.validationIssues = [...(receipt.validationIssues ?? []), flag];
    log.warn(
      { mismatchedItemCount, productCount, totalMismatched },
      'LOW_IMAGE_QUALITY: OCR unreliable, suppressing per-item OCR warnings',
    );
    return;
  }

  if (candidateIssues.length > 0) {
    receipt.validationIssues = [...(receipt.validationIssues ?? []), ...candidateIssues];
    log.warn({ count: candidateIssues.length }, 'OCR cross-validation: mismatches detected');
  }
}

/**
 * Extracts all numbers from OCR text. Handles EU (1.234,56) and US (1,234.56)
 * conventions, stitches numbers split by whitespace ("69, 99" → "69,99"), and
 * supports up to 3-decimal precision (e.g. fuel prices like €1.485/L).
 * Ambiguous tokens are added in BOTH interpretations to maximize recall.
 */
export function extractOcrNumbers(ocrText: string): number[] {
  const numbers: number[] = [];
  const compacted = ocrText.replace(/(\d)\s*([.,])\s*(\d)/g, '$1$2$3');
  const numberRegex = /\d{1,3}(?:[.,]\d{3})*[.,]\d{1,4}|\d+[.,]\d{1,4}|\d{1,7}/g;
  for (const match of compacted.matchAll(numberRegex)) {
    for (const value of normalizeOcrNumber(match[0])) {
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
export function normalizeOcrNumber(raw: string): number[] {
  const cleaned = raw.replace(/\s/g, '');
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  const results: number[] = [];

  const pushParsed = (intPart: string, decPart: string) => {
    const num = parseFloat(`${intPart || '0'}.${decPart || '0'}`);
    if (!isNaN(num)) results.push(num);
  };

  if (lastDot > -1 && lastComma > -1) {
    if (lastDot > lastComma) {
      pushParsed(cleaned.substring(0, lastDot).replace(/,/g, ''), cleaned.substring(lastDot + 1));
    } else {
      pushParsed(cleaned.substring(0, lastComma).replace(/\./g, ''), cleaned.substring(lastComma + 1));
    }
  } else if (lastDot > -1 || lastComma > -1) {
    const idx = lastDot > -1 ? lastDot : lastComma;
    const sep = lastDot > -1 ? '.' : ',';
    const tail = cleaned.substring(idx + 1);
    const head = cleaned.substring(0, idx);

    if (tail.length <= 3) {
      pushParsed(head, tail);
    }
    if (tail.length === 3) {
      pushParsed(head + tail, '0');
    }
    if (tail.length > 3) {
      pushParsed(cleaned.split(sep).join(''), '0');
    }
  } else {
    pushParsed(cleaned, '0');
  }

  return results;
}

/** Returns up to ~160 chars of OCR text around the first match of `needle`. */
export function ocrContextAround(ocrText: string, needle: string): string {
  const idx = ocrText.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return '(description not found in OCR)';
  const start = Math.max(0, idx - 80);
  const end = Math.min(ocrText.length, idx + needle.length + 80);
  return ocrText.substring(start, end).replace(/\s+/g, ' ');
}
