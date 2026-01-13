import { relations } from 'drizzle-orm';
import { mysqlTable, varchar, serial, decimal, date, mysqlEnum, int, text, json, timestamp, tinyint, } from 'drizzle-orm/mysql-core';
// --- Users Table (unchanged) ---
export const users = mysqlTable('users', {
    id: serial('id').primaryKey(),
    apiKey: varchar('api_key', { length: 255 }).notNull().unique(),
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
// --- Modified and Existing Tables ---
export const receipts = mysqlTable('receipts', {
    id: serial('id').primaryKey(),
    uploadId: int('upload_id').notNull(),
    storeName: varchar('store_name', { length: 255 }),
    totalAmount: decimal('total_amount', { precision: 10, scale: 2 }),
    taxAmount: decimal('tax_amount', { precision: 10, scale: 2 }),
    transactionDate: date('transaction_date'),
    status: mysqlEnum('status', ['pending', 'processed', 'failed', 'unreadable'])
        .default('pending')
        .notNull(),
    imageUrl: varchar('image_url', { length: 2048 }), // URL of the individual cropped receipt image
    keywords: json('keywords'),
});
export const lineItems = mysqlTable('line_items', {
    id: serial('id').primaryKey(),
    receiptId: int('receipt_id').notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    quantity: decimal('quantity', { precision: 10, scale: 3 }).default('1.0'),
    unitPrice: decimal('unit_price', { precision: 10, scale: 2 }).notNull(),
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
