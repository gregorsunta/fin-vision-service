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
  // uploadId alone is NOT a safe join key — receipt_uploads and
  // bank_statement_uploads each have their own independent auto-increment
  // sequence, so the same numeric id gets reused across both domains.
  // uploadType disambiguates which table uploadId actually points into;
  // every query against this table MUST filter on both columns together.
  uploadType: mysqlEnum('upload_type', ['receipt', 'bank_statement']).notNull().default('receipt'),
  uploadId: int('upload_id').notNull(),
  receiptId: int('receipt_id'), // Can be null if the error is for the whole upload
  category: mysqlEnum('category', ['IMAGE_QUALITY', 'EXTRACTION_FAILURE', 'SYSTEM_ERROR', 'VALIDATION_WARNING']).notNull(),
  message: text('message'),
  metadata: json('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  uploadIdIdx: index('idx_processing_errors_upload_id').on(table.uploadType, table.uploadId),
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
  entityType: mysqlEnum('entity_type', [
    'receipt',
    'line_item',
    'bank_account',
    'bank_statement_upload',
    'bank_transaction',
  ]).notNull(),
  entityId: int('entity_id').notNull(),
  fieldName: varchar('field_name', { length: 100 }).notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  changedBy: int('changed_by').notNull(),
  changedAt: timestamp('changed_at').defaultNow().notNull(),
}, (table) => ({
  entityIdx: index('idx_entity').on(table.entityType, table.entityId, table.fieldName, table.changedAt),
}));

// --- Bank statements feature ---

// User-owned bank accounts. Created manually by user or auto-created when a statement
// contains an unrecognized IBAN. Canonical key is (userId, iban).
export const bankAccounts = mysqlTable('bank_accounts', {
  id: serial('id').primaryKey(),
  userId: int('user_id').notNull(),
  iban: varchar('iban', { length: 34 }).notNull(),
  accountName: varchar('account_name', { length: 255 }),
  bankName: varchar('bank_name', { length: 255 }),
  currency: varchar('currency', { length: 3 }).default('EUR').notNull(),
  isAutoCreated: boolean('is_auto_created').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  uqUserIban: uniqueIndex('uq_bank_accounts_user_iban').on(table.userId, table.iban),
  userIdIdx: index('idx_bank_accounts_user_id').on(table.userId),
}));

// One uploaded statement file. May cover one or more months. Each file produces
// many bank_transactions rows.
export const bankStatementUploads = mysqlTable('bank_statement_uploads', {
  id: serial('id').primaryKey(),
  userId: int('user_id').notNull(),
  // Null until IBAN is recognized or user assigns an account manually.
  bankAccountId: int('bank_account_id'),
  uploadNumber: int('upload_number').notNull(),
  originalFileName: varchar('original_file_name', { length: 255 }),
  fileUrl: varchar('file_url', { length: 2048 }).notNull(),
  // Original, uncompressed file before any processing; null once cleaned up.
  rawFileUrl: varchar('raw_file_url', { length: 2048 }),
  fileHash: varchar('file_hash', { length: 64 }),
  mimeType: varchar('mime_type', { length: 100 }).notNull(),
  periodStart: datetime('period_start'),
  periodEnd: datetime('period_end'),
  openingBalance: decimal('opening_balance', { precision: 15, scale: 4 }),
  closingBalance: decimal('closing_balance', { precision: 15, scale: 4 }),
  totalDebit: decimal('total_debit', { precision: 15, scale: 4 }),
  totalCredit: decimal('total_credit', { precision: 15, scale: 4 }),
  status: mysqlEnum('status', [
    'processing',
    'pending_user_review',
    'completed',
    'partly_completed',
    'failed',
    'duplicate',
    'needs_account_selection',
  ]).default('processing').notNull(),
  parsingMetadata: json('parsing_metadata').$type<{
    parser: 'native-pdf' | 'pdfplumber' | 'csv' | 'xlsx' | 'ocr-ai' | 'local-rules';
    parserVersion?: string;
    detectedIban?: string;
    detectedBankName?: string;
    transactionCount: number;
    warnings?: Array<{ code: string; message: string; row?: number }>;
    processedAt: string;
    durationMs?: number;
  }>(),
  splitMetadata: json('split_metadata'),
  // GDPR review-gate fields. See workers/bankStatement* and routes/bank-statements/review.ts.
  // The redacted text is stored ONLY between Phase 1 (parse + redact) and Phase 2 (AI send).
  // It is shown to the user for explicit confirmation before any external API call. Cleared
  // after Phase 2 completes (or after TTL / cancel).
  redactedText: text('redacted_text'),
  redactionStats: json('redaction_stats').$type<{
    emails: number;
    phones: number;
    ibans: number;
    addresses: number;
    taxIds: number;
    persons: number;
  }>(),
  // Locally-detected IBAN, kept so Phase 2 can re-run redactPII with the same primary IBAN.
  detectedIban: varchar('detected_iban', { length: 34 }),
  userConfirmedAt: timestamp('user_confirmed_at'),
  userConfirmedFromIp: varchar('user_confirmed_from_ip', { length: 45 }),
  pendingReviewExpiresAt: timestamp('pending_review_expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  uqUserUploadNumber: uniqueIndex('uq_bank_statement_upload_number').on(table.userId, table.uploadNumber),
  userIdIdx: index('idx_bank_statement_uploads_user_id').on(table.userId),
  bankAccountIdIdx: index('idx_bank_statement_uploads_bank_account_id').on(table.bankAccountId),
  statusIdx: index('idx_bank_statement_uploads_status').on(table.status),
}));

// Individual transactions extracted from a bank_statement_upload.
// userId and bankAccountId are denormalized for efficient period/account queries
// on the unified analysis page (avoids always joining through uploads).
export const bankTransactions = mysqlTable('bank_transactions', {
  id: serial('id').primaryKey(),
  statementUploadId: int('statement_upload_id').notNull(),
  bankAccountId: int('bank_account_id').notNull(),
  userId: int('user_id').notNull(),
  transactionDate: datetime('transaction_date').notNull(),
  valueDate: datetime('value_date'),
  // GDPR whitelist: counterparty names, counterparty IBANs and payment refs
  // (sklic) are intentionally not persisted. The `description` field is kept
  // but PII-redacted at parse time (see services/bank-statement/pii-filter.ts).
  description: text('description'),
  debit: decimal('debit', { precision: 15, scale: 4 }),
  credit: decimal('credit', { precision: 15, scale: 4 }),
  runningBalance: decimal('running_balance', { precision: 15, scale: 4 }),
  currency: varchar('currency', { length: 3 }).notNull(),
  category: varchar('category', { length: 50 }),
  isDuplicate: boolean('is_duplicate').default(false).notNull(),
  duplicateOfTransactionId: int('duplicate_of_transaction_id'),
  duplicateConfidenceScore: decimal('duplicate_confidence_score', { precision: 5, scale: 2 }),
  duplicateOverride: boolean('duplicate_override').default(false).notNull(),
  confidenceScores: json('confidence_scores').$type<{
    date: number;
    amount: number;
    description: number;
  }>(),
  editedAt: timestamp('edited_at'),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  statementUploadIdIdx: index('idx_bank_transactions_statement_upload_id').on(table.statementUploadId),
  userIdDateIdx: index('idx_bank_transactions_user_date').on(table.userId, table.transactionDate),
  bankAccountIdDateIdx: index('idx_bank_transactions_account_date').on(table.bankAccountId, table.transactionDate),
}));

// Confidence-scored match between a bank transaction and a receipt. A single
// transaction typically has at most one confirmed match, but the table allows
// several pending candidates until the user picks one.
export const transactionReceiptMatches = mysqlTable('transaction_receipt_matches', {
  id: serial('id').primaryKey(),
  transactionId: int('transaction_id').notNull(),
  receiptId: int('receipt_id').notNull(),
  confidenceScore: decimal('confidence_score', { precision: 5, scale: 2 }).notNull(),
  matchFactors: json('match_factors').$type<{
    amount: { score: number; difference: number };
    date: { score: number; daysDifference: number };
    description: { score: number; overlap: number };
  }>(),
  userAction: mysqlEnum('user_action', ['pending', 'confirmed', 'rejected'])
    .default('pending')
    .notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  transactionIdIdx: index('idx_transaction_receipt_matches_transaction_id').on(table.transactionId),
  receiptIdIdx: index('idx_transaction_receipt_matches_receipt_id').on(table.receiptId),
  uqTxReceipt: uniqueIndex('uq_transaction_receipt_matches_tx_receipt').on(table.transactionId, table.receiptId),
}));

// --- Relations ---
export const usersRelations = relations(users, ({ many }) => ({
  receiptUploads: many(receiptUploads),
  bankAccounts: many(bankAccounts),
  bankStatementUploads: many(bankStatementUploads),
  bankTransactions: many(bankTransactions),
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

export const bankAccountsRelations = relations(bankAccounts, ({ one, many }) => ({
  user: one(users, {
    fields: [bankAccounts.userId],
    references: [users.id],
  }),
  statementUploads: many(bankStatementUploads),
  transactions: many(bankTransactions),
}));

export const bankStatementUploadsRelations = relations(bankStatementUploads, ({ one, many }) => ({
  user: one(users, {
    fields: [bankStatementUploads.userId],
    references: [users.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [bankStatementUploads.bankAccountId],
    references: [bankAccounts.id],
  }),
  transactions: many(bankTransactions),
}));

export const bankTransactionsRelations = relations(bankTransactions, ({ one, many }) => ({
  statementUpload: one(bankStatementUploads, {
    fields: [bankTransactions.statementUploadId],
    references: [bankStatementUploads.id],
  }),
  bankAccount: one(bankAccounts, {
    fields: [bankTransactions.bankAccountId],
    references: [bankAccounts.id],
  }),
  user: one(users, {
    fields: [bankTransactions.userId],
    references: [users.id],
  }),
  duplicateOf: one(bankTransactions, {
    fields: [bankTransactions.duplicateOfTransactionId],
    references: [bankTransactions.id],
    relationName: 'txDuplicate',
  }),
  receiptMatches: many(transactionReceiptMatches),
}));

export const transactionReceiptMatchesRelations = relations(transactionReceiptMatches, ({ one }) => ({
  transaction: one(bankTransactions, {
    fields: [transactionReceiptMatches.transactionId],
    references: [bankTransactions.id],
  }),
  receipt: one(receipts, {
    fields: [transactionReceiptMatches.receiptId],
    references: [receipts.id],
  }),
}));