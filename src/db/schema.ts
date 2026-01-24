import { relations } from 'drizzle-orm';
import {
  mysqlTable,
  varchar,
  serial,
  decimal,
  date,
  mysqlEnum,
  int,
  text,
  json,
  timestamp,
  tinyint,
  boolean,
} from 'drizzle-orm/mysql-core';

// --- Users Table (unchanged) ---
export const users = mysqlTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  // NOTE: In a real production environment, this should be a securely hashed password.
  password: text('password').notNull(),
  apiKey: varchar('api_key', { length: 255 }).unique(),
  refreshToken: text('refresh_token'),
});

// --- New Tables ---
export const receiptUploads = mysqlTable('receipt_uploads', {
  id: serial('id').primaryKey(),
  userId: int('user_id').notNull(),
  originalImageUrl: varchar('original_image_url', { length: 2048 }).notNull(),
  markedImageUrl: varchar('marked_image_url', { length: 2048 }),
  status: mysqlEnum('status', ['processing', 'completed', 'partly_completed', 'failed'])
    .default('processing')
    .notNull(),
  hasReceipts: tinyint('has_receipts'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
});

export const processingErrors = mysqlTable('processing_errors', {
  id: serial('id').primaryKey(),
  uploadId: int('upload_id').notNull(),
  receiptId: int('receipt_id'), // Can be null if the error is for the whole upload
  category: mysqlEnum('category', ['IMAGE_QUALITY', 'EXTRACTION_FAILURE', 'SYSTEM_ERROR']).notNull(),
  message: text('message'),
  metadata: json('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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
});

// --- Modified and Existing Tables ---
export const receipts = mysqlTable('receipts', {
  id: serial('id').primaryKey(),
  uploadId: int('upload_id').notNull(),
  storeName: varchar('store_name', { length: 255 }),
  // Increased precision for monetary values to handle different currencies and calculations more accurately.
  totalAmount: decimal('total_amount', { precision: 13, scale: 4 }),
  taxAmount: decimal('tax_amount', { precision: 13, scale: 4 }),
  transactionDate: date('transaction_date'),
  // Enforcing ISO 4217 3-letter currency codes.
  currency: varchar('currency', { length: 3 }), // e.g., USD, EUR, GBP
  status: mysqlEnum('status', ['pending', 'processed', 'failed', 'unreadable'])
    .default('pending')
    .notNull(),
  imageUrl: varchar('image_url', { length: 2048 }), // URL of the individual cropped receipt image
  keywords: json('keywords'),
  
  // Duplicate detection fields
  isDuplicate: boolean('is_duplicate').default(false),
  duplicateOfReceiptId: int('duplicate_of_receipt_id'), // References receipts.id
  duplicateConfidenceScore: decimal('duplicate_confidence_score', { precision: 5, scale: 2 }), // 0-100
  duplicateCheckedAt: timestamp('duplicate_checked_at'),
  duplicateOverride: boolean('duplicate_override').default(false), // User confirmed not a duplicate
});

export const lineItems = mysqlTable('line_items', {
  id: serial('id').primaryKey(),
  receiptId: int('receipt_id').notNull(),
  description: varchar('description', { length: 255 }).notNull(),
  // Renamed 'quantity' to 'amount' for clarity, as it can represent weight, volume, or a simple count.
  amount: decimal('amount', { precision: 10, scale: 3 }).default('1.0'),
  // Renamed 'quantityUnit' to 'unit' for brevity and clarity.
  unit: varchar('unit', { length: 50 }), // e.g., "pcs", "kg", "lbs", "liters"
  // This new field stores the price for a single unit, which is often on receipts but sometimes needs calculation. Can be null.
  pricePerUnit: decimal('price_per_unit', { precision: 13, scale: 4 }),
  // The original 'unitPrice' was likely intended to be the line item's total price.
  // Renaming to 'totalPrice' for clarity. A line item must have a total price.
  totalPrice: decimal('total_price', { precision: 13, scale: 4 }).notNull(),
  keywords: json('keywords'),
});


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

export const lineItemsRelations = relations(lineItems, ({ one }) => ({
  receipt: one(receipts, {
    fields: [lineItems.receiptId],
    references: [receipts.id],
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