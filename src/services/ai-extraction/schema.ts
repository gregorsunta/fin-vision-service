import { SchemaType } from '@google/generative-ai';

export const receiptExtractionSchema = {
  type: SchemaType.OBJECT,
  properties: {
    notAReceipt: { type: SchemaType.BOOLEAN, nullable: true },
    receiptFormat: { type: SchemaType.STRING, nullable: true },
    region: { type: SchemaType.STRING, enum: ['eu', 'us', 'other'], nullable: true },
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
          lineTotal: { type: SchemaType.NUMBER, nullable: true },
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
          discountPerUnit: {
            type: SchemaType.NUMBER,
            nullable: true,
          },
          unitPriceExVat: {
            type: SchemaType.NUMBER,
            nullable: true,
          },
          extractionFlag: {
            type: SchemaType.STRING,
            nullable: true,
            enum: ['text_unclear', 'value_estimated', 'partially_visible', 'ambiguous'],
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
    extractionWarnings: {
      type: SchemaType.ARRAY,
      nullable: true,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          field: { type: SchemaType.STRING },
          reason: {
            type: SchemaType.STRING,
            enum: ['text_unclear', 'value_estimated', 'partially_visible', 'ambiguous'],
          },
          detail: { type: SchemaType.STRING, nullable: true },
        },
        required: ['field', 'reason'],
      },
    },
  },
  required: [
    'region',
    'receiptFormat',
    'merchantName',
    'transactionDate',
    'transactionTime',
    'items',
    'total',
    'currency',
    'confidenceScores',
  ],
};

export type ExtractionFlagSource = 'llm_uncertain' | 'ocr_mismatch' | 'low_confidence';
export type ExtractionFlagReason = 'text_unclear' | 'value_estimated' | 'partially_visible' | 'ambiguous' | 'not_in_ocr';
export interface ExtractionFlag {
  source: ExtractionFlagSource;
  reason: ExtractionFlagReason;
  detail?: string;
}

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
  discountPerUnit?: number;
  unitPriceExVat?: number;
  extractionFlag?: 'text_unclear' | 'value_estimated' | 'partially_visible' | 'ambiguous';
  _ocrMismatch?: boolean;
}

export interface ValidationIssue {
  severity: 'warning' | 'error';
  type:
    | 'PRICE_MISMATCH'
    | 'INVALID_PRICE'
    | 'UNREALISTIC_PRICE'
    | 'INVALID_DATE'
    | 'UNREALISTIC_QUANTITY'
    | 'MISSING_MERCHANT'
    | 'OCR_MISMATCH'
    | 'LOW_IMAGE_QUALITY';
  message: string;
  details?: unknown;
}

export interface ConfidenceScores {
  merchantName: number;
  transactionDate: number;
  total: number;
  items: number;
}

export type ReceiptFormat = 'simple' | 'multiline-qty' | 'five-column-discount' | 'tabular';
export type ReceiptRegion = 'eu' | 'us' | 'other';

export interface ReceiptData {
  notAReceipt?: boolean;
  receiptFormat?: ReceiptFormat;
  region?: ReceiptRegion;
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
  extractionWarnings?: Array<{ field: string; reason: string; detail?: string }>;
  processingMetadata?: {
    ocrUsed: boolean;
    ocrProvider?: string;
    ocrCharCount?: number;
    analysisModel: string;
    analysisProvider?: string;
    processedAt: string;
    receiptFormat?: string;
    region?: string;
    retryCount?: number;
    retryReason?: string;
  };
}
