import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validatePrices,
  crossValidateWithOCR,
  extractOcrNumbers,
  normalizeOcrNumber,
} from '../src/services/ai-extraction/validator.js';
import type { ReceiptData } from '../src/services/ai-extraction/schema.js';

// Logger side-effects are irrelevant in unit tests
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeReceipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    merchantName: 'Test Store',
    transactionDate: '2024-06-15',
    transactionTime: '10:00:00',
    items: [
      { description: 'Milk 1L', quantity: 2, unitPrice: 1.5, lineTotal: 3.0, itemType: 'product' },
      { description: 'Bread', quantity: 1, unitPrice: 2.0, lineTotal: 2.0, itemType: 'product' },
    ],
    subtotal: null,
    tax: null,
    total: 5.0,
    currency: 'EUR',
    ...overrides,
  };
}

// ─── normalizeOcrNumber ────────────────────────────────────────────────────

describe('normalizeOcrNumber', () => {
  it('parses EU decimal format', () => {
    expect(normalizeOcrNumber('1,99')).toContain(1.99);
  });

  it('parses US decimal format', () => {
    expect(normalizeOcrNumber('1.99')).toContain(1.99);
  });

  it('parses EU thousands with decimal', () => {
    expect(normalizeOcrNumber('1.234,56')).toContain(1234.56);
  });

  it('parses US thousands with decimal', () => {
    expect(normalizeOcrNumber('1,234.56')).toContain(1234.56);
  });

  it('returns both interpretations for ambiguous 3-decimal', () => {
    // "1.485" could be 1.485 (decimal) or 1485 (thousands grouping)
    const result = normalizeOcrNumber('1.485');
    expect(result).toContain(1.485);
    expect(result).toContain(1485);
  });

  it('parses integer', () => {
    expect(normalizeOcrNumber('42')).toContain(42);
  });
});

// ─── extractOcrNumbers ────────────────────────────────────────────────────

describe('extractOcrNumbers', () => {
  it('extracts multiple prices from receipt text', () => {
    const text = 'Milk  1,50\nBread  2,00\nTOTAL  3,50';
    const numbers = extractOcrNumbers(text);
    expect(numbers).toContain(1.5);
    expect(numbers).toContain(2.0);
    expect(numbers).toContain(3.5);
  });

  it('handles stray whitespace within numbers', () => {
    // "69, 99" → "69,99" → 69.99
    const numbers = extractOcrNumbers('Total: 69, 99');
    expect(numbers).toContain(69.99);
  });

  it('handles fuel-price 3-decimal values', () => {
    const numbers = extractOcrNumbers('€1.485/L');
    expect(numbers).toContain(1.485);
  });

  it('returns empty array for text with no numbers', () => {
    expect(extractOcrNumbers('No prices here!')).toHaveLength(0);
  });
});

// ─── validatePrices ───────────────────────────────────────────────────────

describe('validatePrices', () => {
  it('passes when items sum matches total', () => {
    const receipt = makeReceipt();
    validatePrices(receipt);
    expect(receipt.validationIssues).toBeUndefined();
  });

  it('adds PRICE_MISMATCH when items sum differs > €0.05', () => {
    const receipt = makeReceipt({ total: 10.0 }); // items sum to 5.0
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'PRICE_MISMATCH')).toBe(true);
  });

  it('does not add PRICE_MISMATCH within tolerance (≤ €0.05)', () => {
    const receipt = makeReceipt({ total: 5.03 });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'PRICE_MISMATCH')).toBeFalsy();
  });

  it('adds INVALID_PRICE for zero-lineTotal product item', () => {
    const receipt = makeReceipt({
      items: [{ description: 'Ghost', quantity: 1, unitPrice: 0, lineTotal: 0, itemType: 'product' }],
      total: 0,
    });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'INVALID_PRICE')).toBe(true);
  });

  it('adds INVALID_PRICE when product has negative lineTotal', () => {
    const receipt = makeReceipt({
      items: [{ description: 'Refund', quantity: 1, unitPrice: -5, lineTotal: -5, itemType: 'product' }],
      total: -5,
    });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'INVALID_PRICE')).toBe(true);
  });

  it('adds INVALID_PRICE when discount item has positive lineTotal', () => {
    const receipt = makeReceipt({
      items: [{ description: 'Bad Discount', quantity: 1, unitPrice: 5, lineTotal: 5, itemType: 'discount' }],
      total: 5,
    });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'INVALID_PRICE')).toBe(true);
  });

  it('adds UNREALISTIC_PRICE when lineTotal > 10000', () => {
    const receipt = makeReceipt({
      items: [{ description: 'Yacht', quantity: 1, unitPrice: 50000, lineTotal: 50000, itemType: 'product' }],
      total: 50000,
    });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'UNREALISTIC_PRICE')).toBe(true);
  });

  it('adds MISSING_MERCHANT when merchantName is empty', () => {
    const receipt = makeReceipt({ merchantName: '' });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'MISSING_MERCHANT')).toBe(true);
  });

  it('does not flag past dates', () => {
    const receipt = makeReceipt({ transactionDate: '2020-01-01' });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'INVALID_DATE')).toBeFalsy();
  });

  it('adds INVALID_DATE for far-future date that cannot be fixed by day/month swap', () => {
    // 2099-06-15 → swap → 2099-15-06 which is invalid, so no auto-correct
    const receipt = makeReceipt({ transactionDate: '2099-06-15', region: 'eu' });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'INVALID_DATE')).toBe(true);
  });

  it('silently corrects EU date-swap (DD.MM read as MM.DD)', () => {
    // Simulate: receipt date is "4.7.2026" (July 4th, EU format), but AI read it
    // as "2026-07-04" (future). Swap → "2026-04-07" (April 7th, past) → auto-correct.
    // This test assumes it runs any time after 2026-04-07 and before 2026-07-04.
    const futureDate = '2026-07-04'; // July 4, 2026 — future at time of writing
    const swapped = '2026-04-07';   // April 7, 2026 — past at time of writing
    const receipt = makeReceipt({ transactionDate: futureDate, region: 'eu' });
    validatePrices(receipt);
    expect(receipt.transactionDate).toBe(swapped);
    expect(receipt.validationIssues?.some((i) => i.type === 'INVALID_DATE')).toBeFalsy();
  });

  it('does NOT swap dates for US receipts', () => {
    const futureDate = '2026-07-04'; // future at time of writing
    const receipt = makeReceipt({ transactionDate: futureDate, region: 'us' });
    validatePrices(receipt);
    // US receipts skip the swap heuristic — should get INVALID_DATE instead
    expect(receipt.transactionDate).toBe(futureDate);
    expect(receipt.validationIssues?.some((i) => i.type === 'INVALID_DATE')).toBe(true);
  });

  it('adds UNREALISTIC_QUANTITY for product with quantity > 100', () => {
    const receipt = makeReceipt({
      items: [{ description: 'Bulk', quantity: 999, unitPrice: 1, lineTotal: 999, itemType: 'product' }],
      total: 999,
    });
    validatePrices(receipt);
    expect(receipt.validationIssues?.some((i) => i.type === 'UNREALISTIC_QUANTITY')).toBe(true);
  });
});

// ─── crossValidateWithOCR ─────────────────────────────────────────────────

describe('crossValidateWithOCR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds no issues when all values appear in OCR', () => {
    const receipt = makeReceipt();
    const ocrText = 'Milk 1L  1,50\nBread  2,00\nTotal  5,00';
    crossValidateWithOCR(receipt, ocrText);
    const ocrIssues = receipt.validationIssues?.filter((i) => i.type === 'OCR_MISMATCH') ?? [];
    expect(ocrIssues).toHaveLength(0);
  });

  it('adds OCR_MISMATCH when total not in OCR', () => {
    const receipt = makeReceipt({ total: 99.99 });
    const ocrText = 'Milk 1,50\nBread 2,00';
    crossValidateWithOCR(receipt, ocrText);
    expect(receipt.validationIssues?.some((i) => i.type === 'OCR_MISMATCH')).toBe(true);
  });

  it('emits LOW_IMAGE_QUALITY instead of per-item noise when OCR is globally unreliable', () => {
    // 4 products, none with prices in OCR — triggers ocrUnreliable path
    const receipt = makeReceipt({
      items: [
        { description: 'A', quantity: 1, unitPrice: 11.11, lineTotal: 11.11, itemType: 'product' },
        { description: 'B', quantity: 1, unitPrice: 22.22, lineTotal: 22.22, itemType: 'product' },
        { description: 'C', quantity: 1, unitPrice: 33.33, lineTotal: 33.33, itemType: 'product' },
        { description: 'D', quantity: 1, unitPrice: 44.44, lineTotal: 44.44, itemType: 'product' },
      ],
      total: 99.99, // also not in OCR
    });
    const ocrText = 'some random text without any relevant prices';
    crossValidateWithOCR(receipt, ocrText);
    expect(receipt.validationIssues?.some((i) => i.type === 'LOW_IMAGE_QUALITY')).toBe(true);
    // Should NOT have per-item OCR_MISMATCH issues
    expect(receipt.validationIssues?.some((i) => i.type === 'OCR_MISMATCH')).toBe(false);
  });
});
