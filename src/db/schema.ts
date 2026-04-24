import { relations } from 'drizzle-orm';
import {
  mysqlTable,
  varchar,
  serial,
  decimal,
  datetime,
  mysqlEnum,
  int,
  text,
  json,
  timestamp,
  tinyint,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';

// --- Users Table (unchanged) ---
export const users = mysqlTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  // NOTE: In a real production environment, this should be a securely hashed password.
  password: text('password').notNull(),
  apiKey: varchar('api_key', { length: 255 }).unique(),
  refreshToken: text('refresh_token'),
  autoResumeRateLimited: boolean('auto_resume_rate_limited').default(false).notNull(),
  exportSettings: json('export_settings').$type<{
    decimalSeparator: '.' | ',';
    amountFormat: 'decimal' | 'cents' | 'integer4dp';
    dateFormat: 'YYYY-MM-DD' | 'DD.MM.YYYY' | 'MM/DD/YYYY';
    includeCurrency: boolean;
    includeHeader: boolean;
  }>(),
});

// --- New Tables ---
export const receiptUploads = mysqlTable('receipt_uploads', {
  id: serial('id').primaryKey(),
  userId: int('user_id').notNull(),
  uploadNumber: int('upload_number').notNull(),
  // uploadNumber is unique per user — enforced by uq_user_upload_number index
  originalImageUrl: varchar('original_image_url', { length: 2048 }).notNull(),
  rawImageUrl: varchar('raw_image_url', { length: 2048 }), // original uploaded file before compression; null = cleaned up or duplicate
  markedImageUrl: varchar('marked_image_url', { length: 2048 }),
  imageHash: varchar('image_hash', { length: 64 }),
  perceptualHash: varchar('perceptual_hash', { length: 16 }),
  originalFileName: varchar('original_file_name', { length: 255 }), // original filename as uploaded by the user
  status: mysqlEnum('status', ['processing', 'completed', 'partly_completed', 'failed', 'duplicate'])
    .default('processing')
    .notNull(),
  hasReceipts: tinyint('has_receipts'),
  splitMetadata: json('split_metadata').$type<{
    rawResponse: string;
    rawBoundingBoxes: { x: number; y: number; width: number; height: number }[];
    mergedBoundingBoxes: { x: number; y: number; width: number; height: number }[];
    provider: string;
    model: string;
    detectedCount: number;
    mergedCount: number;
  }>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  uqUserUploadNumber: uniqueIndex('uq_user_upload_number').on(table.userId, table.uploadNumber),
}));

export const processingErrors = mysqlTable('processing_errors', {
  id: serial('id').primaryKey(),
  uploadId: int('upload_id').notNull(),
  receiptId: int('receipt_id'), // Can be null if the error is for the whole upload
  category: mysqlEnum('category', ['IMAGE_QUALITY', 'EXTRACTION_FAILURE', 'SYSTEM_ERROR', 'VALIDATION_WARNING']).notNull(),
  message: text('message'),
  metadata: json('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  uploadIdIdx: index('idx_processing_errors_upload_id').on(table.uploadId),
}));

// Duplicate detection matches table
export const duplicateMatches = mysqlTable('duplicate_matches', {
  id: serial('id').primaryKey(),
  receiptId: int('receipt_id').notNull(), // The newly processed receipt
  potentialDuplicateId: int('potential_duplicate_id').notNull(), // Existing receipt it matches
  confidenceScore: decimal('confidence_score', { precision: 5, scale: 2 }).notNull(), // 0-100
  matchFactors: json('match_factors'), // Detailed breakdown of what matched
  userAction: mysqlEnum('user_action', ['confirmed_duplicate', 'override', 'pending'])
    .default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  receiptIdIdx: index('idx_duplicate_matches_receipt_id').on(table.receiptId),
  potentialIdIdx: index('idx_duplicate_matches_potential_id').on(table.potentialDuplicateId),
}));

// --- Modified and Existing Tables ---
export const receipts = mysqlTable('receipts', {
  id: serial('id').primaryKey(),
  uploadId: int('upload_id').notNull(),
  storeName: varchar('store_name', { length: 255 }),
  // Increased precision for monetary values to handle different currencies and calculations more accurately.
  totalAmount: decimal('total_amount', { precision: 13, scale: 4 }),
  taxAmount: decimal('tax_amount', { precision: 13, scale: 4 }),
  transactionDate: datetime('transaction_date'),
  // Enforcing ISO 4217 3-letter currency codes.
  currency: varchar('currency', { length: 3 }), // e.g., USD, EUR, GBP
  status: mysqlEnum('status', ['pending', 'processed', 'failed', 'unreadable', 'rate_limited'])
    .default('pending')
    .notNull(),
  reviewStatus: mysqlEnum('review_status', ['not_required', 'needs_review', 'reviewed'])
    .default('not_required')
    .notNull(),
  imageUrl: varchar('image_url', { length: 2048 }),
  ocrText: text('ocr_text'),
  keywords: json('keywords'),
  category: varchar('category', { length: 50 }),
  
  // Duplicate detection fields
  isDuplicate: boolean('is_duplicate').default(false),
  duplicateOfReceiptId: int('duplicate_of_receipt_id'), // References receipts.id
  duplicateConfidenceScore: decimal('duplicate_confidence_score', { precision: 5, scale: 2 }), // 0-100
  duplicateCheckedAt: timestamp('duplicate_checked_at'),
  duplicateOverride: boolean('duplicate_override').default(false), // User confirmed not a duplicate

  processingMetadata: json('processing_metadata').$type<{
    ocrUsed: boolean;
    ocrProvider?: string;
    ocrCharCount?: number;
    analysisModel: string;
    analysisProvider?: string;
    processedAt: string;
    retryCount?: number;
    retryReason?: string;
    fieldWarnings?: Array<{
      field: string;
      source: 'llm_uncertain' | 'ocr_mismatch' | 'low_confidence';
      reason: string;
      detail?: string;
    }>;
  }>(),
  confidenceScores: json('confidence_scores').$type<{
    merchantName: number;
    transactionDate: number;
    total: number;
    items: number;
  }>(),
  editedAt: timestamp('edited_at'),
  itemsNonReadable: boolean('items_non_readable').default(false).notNull(),
  imageRotation: int('image_rotation').notNull().default(0),
  deletedAt: timestamp('deleted_at'),
  userReceiptNumber: int('user_receipt_number').notNull(),
}, (table) => ({
  uploadIdIdx: index('idx_receipts_upload_id').on(table.uploadId),
  statusIdx: index('idx_receipts_status').on(table.status),
  reviewStatusIdx: index('idx_receipts_review_status').on(table.reviewStatus),
}));

export const lineItems = mysqlTable('line_items', {
  id: serial('id').primaryKey(),
  receiptId: int('receipt_id').notNull(),
  
  // Item type classification
  itemType: mysqlEnum('item_type', [
    'product',      // Regular purchased product
    'discount',     // Price reduction/discount
    'tax',          // Tax line item
    'tip',          // Gratuity/tip
    'fee',          // Service fee, delivery fee, etc.
    'refund',       // Refund/return
    'adjustment'    // Other price adjustments
  ]).default('product').notNull(),
  
  // Optional: Link discount/modifier to a parent product
  parentLineItemId: int('parent_line_item_id'), // Self-reference to line_items.id
  
  // Discount-specific metadata
  discountMetadata: json('discount_metadata').$type<{
    type?: 'percentage' | 'fixed' | 'coupon' | 'loyalty' | 'promotion';
    value?: number;           // Percentage value (e.g., 10 for 10%) or fixed amount
    code?: string;            // Coupon/promo code if applicable
    originalPrice?: number;   // Original price before discount
  }>(),
  
  description: varchar('description', { length: 255 }).notNull(),
  // Renamed 'quantity' to 'amount' for clarity, as it can represent weight, volume, or a simple count.
  amount: decimal('amount', { precision: 10, scale: 3 }).default('1.0'),
  // Renamed 'quantityUnit' to 'unit' for brevity and clarity.
  unit: varchar('unit', { length: 50 }), // e.g., "pcs", "kg", "lbs", "liters"
  // This new field stores the price for a single unit, which is often on receipts but sometimes needs calculation. Can be null.
  pricePerUnit: decimal('price_per_unit', { precision: 13, scale: 4 }),
  // Discount applied per unit (absolute amount, e.g. 0.30 means €0.30 off each unit).
  // Present only on receipts that have a per-row discount column.
  discountPerUnit: decimal('discount_per_unit', { precision: 13, scale: 4 }),
  // Unit price excluding VAT, captured when the receipt shows both ex-VAT and incl-VAT columns.
  unitPriceExVat: decimal('unit_price_ex_vat', { precision: 13, scale: 4 }),
  // The original 'unitPrice' was likely intended to be the line item's total price.
  // Renaming to 'totalPrice' for clarity. A line item must have a total price.
  totalPrice: decimal('total_price', { precision: 13, scale: 4 }).notNull(),
  keywords: json('keywords'),
  category: varchar('category', { length: 50 }),
  subcategory: varchar('subcategory', { length: 50 }),
  confidence: decimal('confidence', { precision: 5, scale: 2 }),
  extractionFlags: json('extraction_flags').$type<{
    source: 'llm_uncertain' | 'ocr_mismatch' | 'low_confidence';
    reason: string;
    detail?: string;
  }>(),
  deletedAt: timestamp('deleted_at'),
  isUserAdded: boolean('is_user_added').default(false).notNull(),
}, (table) => ({
  receiptIdIdx: index('idx_line_items_receipt_id').on(table.receiptId),
}));


export const receiptEditHistory = mysqlTable('receipt_edit_history', {
  id: serial('id').primaryKey(),
  entityType: mysqlEnum('entity_type', ['receipt', 'line_item']).notNull(),
  entityId: int('entity_id').notNull(),
  fieldName: varchar('field_name', { length: 100 }).notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  changedBy: int('changed_by').notNull(),
  changedAt: timestamp('changed_at').defaultNow().notNull(),
}, (table) => ({
  entityIdx: index('idx_entity').on(table.entityType, table.entityId, table.fieldName, table.changedAt),
}));

// --- Relations ---
export const usersRelations = relations(users, ({ many }) => ({
  receiptUploads: many(receiptUploads),
}));

export const receiptUploadsRelations = relations(receiptUploads, ({ one, many }) => ({
  user: one(users, {
    fields: [receiptUploads.userId],
    references: [users.id],
  }),
  receipts: many(receipts),
  errors: many(processingErrors),
}));

export const receiptsRelations = relations(receipts, ({ one, many }) => ({
  upload: one(receiptUploads, {
    fields: [receipts.uploadId],
    references: [receiptUploads.id],
  }),
  lineItems: many(lineItems),
}));

export const lineItemsRelations = relations(lineItems, ({ one, many }) => ({
  receipt: one(receipts, {
    fields: [lineItems.receiptId],
    references: [receipts.id],
  }),
  // Self-referential relation for parent line item (e.g., discount belongs to product)
  parentLineItem: one(lineItems, {
    fields: [lineItems.parentLineItemId],
    references: [lineItems.id],
    relationName: 'parentChild',
  }),
  // Child modifiers (discounts, adjustments) on this item
  childModifiers: many(lineItems, {
    relationName: 'parentChild',
  }),
}));

export const processingErrorsRelations = relations(processingErrors, ({ one }) => ({
  upload: one(receiptUploads, {
    fields: [processingErrors.uploadId],
    references: [receiptUploads.id],
  }),
  receipt: one(receipts, {
    fields: [processingErrors.receiptId],
    references: [receipts.id],
  }),
}));

export const duplicateMatchesRelations = relations(duplicateMatches, ({ one }) => ({
  receipt: one(receipts, {
    fields: [duplicateMatches.receiptId],
    references: [receipts.id],
  }),
  potentialDuplicate: one(receipts, {
    fields: [duplicateMatches.potentialDuplicateId],
    references: [receipts.id],
  }),
}));