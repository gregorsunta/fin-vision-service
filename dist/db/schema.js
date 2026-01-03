import { relations } from 'drizzle-orm';
import { mysqlTable, varchar, serial, decimal, date, mysqlEnum, int, } from 'drizzle-orm/mysql-core';
export const users = mysqlTable('users', {
    id: serial('id').primaryKey(),
    apiKey: varchar('api_key', { length: 255 }).notNull().unique(),
});
export const receipts = mysqlTable('receipts', {
    id: serial('id').primaryKey(),
    userId: int('user_id').notNull(),
    storeName: varchar('store_name', { length: 255 }),
    totalAmount: decimal('total_amount', { precision: 10, scale: 2 }),
    taxAmount: decimal('tax_amount', { precision: 10, scale: 2 }),
    transactionDate: date('transaction_date'),
    status: mysqlEnum('status', ['pending', 'completed', 'failed']).default('pending').notNull(),
    imageUrl: varchar('image_url', { length: 2048 }), // Path to the stored image file
});
export const lineItems = mysqlTable('line_items', {
    id: serial('id').primaryKey(),
    receiptId: int('receipt_id').notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    quantity: decimal('quantity', { precision: 10, scale: 3 }).default('1.0'),
    unitPrice: decimal('unit_price', { precision: 10, scale: 2 }).notNull(),
});
export const usersRelations = relations(users, ({ many }) => ({
    receipts: many(receipts),
}));
export const receiptsRelations = relations(receipts, ({ one, many }) => ({
    user: one(users, {
        fields: [receipts.userId],
        references: [users.id],
    }),
    lineItems: many(lineItems),
}));
export const lineItemsRelations = relations(lineItems, ({ one }) => ({
    receipt: one(receipts, {
        fields: [lineItems.receiptId],
        references: [receipts.id],
    }),
}));
