import path from 'path';
import { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import { db } from '../../db/index.js';
import { receipts, lineItems, receiptUploads, receiptEditHistory, duplicateMatches } from '../../db/schema.js';
import { eq, and, isNull, asc, or, type InferInsertModel } from 'drizzle-orm';

type ReceiptUpdate = Partial<InferInsertModel<typeof receipts>>;
type LineItemUpdate = Partial<InferInsertModel<typeof lineItems>>;
import { compressToWebP, hashFilename, saveFile, UPLOADS_DIR } from '../../utils/file-utils.js';
import { receiptProcessingQueue, ReceiptJobData } from '../../queue/index.js';

/**
 * Recalculates and persists the upload status based on active (non-deleted) receipts.
 * Called after soft-delete or restore so the upload reflects what the user sees.
 */
async function recalcUploadStatus(uploadId: number): Promise<void> {
  const active = await db
    .select({ status: receipts.status })
    .from(receipts)
    .where(and(eq(receipts.uploadId, uploadId), isNull(receipts.deletedAt)));

  let newStatus: 'completed' | 'partly_completed' | 'failed';
  if (active.length === 0) {
    newStatus = 'completed';
  } else if (active.every(r => r.status === 'processed')) {
    newStatus = 'completed';
  } else if (active.every(r => r.status === 'failed' || r.status === 'unreadable')) {
    newStatus = 'failed';
  } else {
    newStatus = 'partly_completed';
  }

  await db.update(receiptUploads).set({ status: newStatus }).where(eq(receiptUploads.id, uploadId));
}

// ---- Types ----

interface ReceiptForEdit {
  id: number;
  uploadId: number;
  storeName: string | null;
  totalAmount: string | null;
  taxAmount: string | null;
  itemsNonReadable: boolean;
  deletedAt: Date | null;
  transactionDate: Date | null;
  currency: string | null;
  status: string;
  editedAt: Date | null;
  imageUrl: string | null;
}

// ---- Helpers ----

async function resolveReceiptForEdit(
  uploadId: number,
  receiptId: number,
  userId: number,
): Promise<{ upload: typeof receiptUploads.$inferSelect; receipt: ReceiptForEdit } | { error: string; statusCode: number }> {
  const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadId));
  if (!upload) return { error: 'Receipt upload not found.', statusCode: 404 };
  if (upload.userId !== userId) return { error: 'Forbidden.', statusCode: 403 };

  const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
  if (!receipt || receipt.uploadId !== uploadId) return { error: 'Receipt not found for this upload.', statusCode: 404 };
  if (receipt.status === 'pending' || receipt.status === 'rate_limited') {
    return { error: 'Cannot edit a receipt that is currently being processed.', statusCode: 409 };
  }

  return { upload, receipt };
}

/** Write history entries for changed fields. Only records fields that actually differ. */
async function writeHistory(
  entityType: 'receipt' | 'line_item',
  entityId: number,
  changedBy: number,
  changes: Record<string, { oldValue: string | null; newValue: string | null }>,
) {
  const entries = Object.entries(changes).filter(
    ([, { oldValue, newValue }]) => oldValue !== newValue,
  );
  if (entries.length === 0) return;

  await db.insert(receiptEditHistory).values(
    entries.map(([fieldName, { oldValue, newValue }]) => ({
      entityType,
      entityId,
      fieldName,
      oldValue,
      newValue,
      changedBy,
      changedAt: new Date(),
    })),
  );
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ---- Routes ----

export default async function receiptEditingRoutes(server: FastifyInstance) {

  // PATCH /receipts/:uploadId/receipt/:receiptId — edit receipt header fields
  server.patch('/receipts/:uploadId/receipt/:receiptId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });
    const { receipt } = resolved;

    const body = request.body as Record<string, unknown>;
    const updateSet: ReceiptUpdate = {};
    const historyChanges: Record<string, { oldValue: string | null; newValue: string | null }> = {};

    const stringFields = ['storeName', 'totalAmount', 'taxAmount', 'currency'] as const;
    for (const field of stringFields) {
      if (!Object.hasOwn(body, field)) continue;
      const newVal = body[field] as string | null;
      updateSet[field] = newVal;
      historyChanges[field] = { oldValue: toStr(receipt[field]), newValue: toStr(newVal) };
    }

    if (Object.hasOwn(body, 'transactionDate')) {
      const newVal = body.transactionDate as string | null;
      updateSet.transactionDate = newVal ? new Date(newVal) : null;
      historyChanges.transactionDate = { oldValue: toStr(receipt.transactionDate), newValue: toStr(newVal) };
    }

    if (Object.hasOwn(body, 'itemsNonReadable') && typeof body.itemsNonReadable === 'boolean') {
      updateSet.itemsNonReadable = body.itemsNonReadable;
      historyChanges.itemsNonReadable = {
        oldValue: receipt.itemsNonReadable ? 'true' : 'false',
        newValue: body.itemsNonReadable ? 'true' : 'false',
      };
    }

    // imageRotation is a display preference — not a data correction, so no editedAt stamp
    // and no edit history entry (not training-relevant).
    if (Object.hasOwn(body, 'imageRotation') && typeof body.imageRotation === 'number') {
      const rotation = body.imageRotation as number;
      if ([0, 90, 180, 270].includes(rotation)) {
        updateSet.imageRotation = rotation;
      }
    }

    if (Object.keys(updateSet).length === 0) {
      return reply.status(400).send({ error: 'No valid fields provided.' });
    }

    const hasDataChanges = Object.keys(historyChanges).length > 0;
    if (hasDataChanges) {
      updateSet.editedAt = new Date();
    }

    await db.update(receipts).set(updateSet).where(eq(receipts.id, receiptIdNum));

    if (hasDataChanges) {
      await writeHistory('receipt', receiptIdNum, request.user.id, historyChanges);
    }

    const [updated] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    return reply.send(updated);
  });

  // PATCH /receipts/:uploadId/receipt/:receiptId/line-items/:lineItemId — edit a line item
  server.patch('/receipts/:uploadId/receipt/:receiptId/line-items/:lineItemId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId, lineItemId } = request.params as { uploadId: string; receiptId: string; lineItemId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    const lineItemIdNum = parseInt(lineItemId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum) || isNaN(lineItemIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });

    const [item] = await db.select().from(lineItems).where(
      and(eq(lineItems.id, lineItemIdNum), eq(lineItems.receiptId, receiptIdNum), isNull(lineItems.deletedAt)),
    );
    if (!item) return reply.status(404).send({ error: 'Line item not found.' });

    const body = request.body as Record<string, unknown>;
    const updateSet: LineItemUpdate = {};
    const historyChanges: Record<string, { oldValue: string | null; newValue: string | null }> = {};

    // description/totalPrice are NOT NULL; nullable fields can be cleared.
    const requiredStringFields = ['description', 'totalPrice'] as const;
    for (const field of requiredStringFields) {
      if (!Object.hasOwn(body, field)) continue;
      const newVal = body[field];
      if (typeof newVal !== 'string' || newVal.length === 0) {
        return reply.status(400).send({ error: `${field} must be a non-empty string.` });
      }
      updateSet[field] = newVal;
      historyChanges[field] = { oldValue: toStr(item[field]), newValue: newVal };
    }

    const nullableStringFields = ['amount', 'unit', 'pricePerUnit', 'discountPerUnit', 'unitPriceExVat'] as const;
    for (const field of nullableStringFields) {
      if (!Object.hasOwn(body, field)) continue;
      const newVal = body[field] as string | null;
      updateSet[field] = newVal;
      historyChanges[field] = { oldValue: toStr(item[field]), newValue: toStr(newVal) };
    }

    if (Object.keys(updateSet).length === 0) {
      return reply.status(400).send({ error: 'No valid fields provided.' });
    }

    await db.update(lineItems).set(updateSet).where(eq(lineItems.id, lineItemIdNum));
    await db.update(receipts).set({ editedAt: new Date() }).where(eq(receipts.id, receiptIdNum));
    await writeHistory('line_item', lineItemIdNum, request.user.id, historyChanges);

    const [updated] = await db.select().from(lineItems).where(eq(lineItems.id, lineItemIdNum));
    return reply.send(updated);
  });

  // POST /receipts/:uploadId/receipt/:receiptId/line-items — add a user-created line item
  server.post('/receipts/:uploadId/receipt/:receiptId/line-items', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });

    const body = request.body as {
      description: string;
      totalPrice: string;
      itemType?: 'product' | 'discount' | 'tax' | 'tip' | 'fee' | 'refund' | 'adjustment';
      amount?: string;
      unit?: string | null;
      pricePerUnit?: string | null;
      category?: string | null;
    };

    if (!body.description || !body.totalPrice) {
      return reply.status(400).send({ error: 'description and totalPrice are required.' });
    }

    const result = await db.insert(lineItems).values({
      receiptId: receiptIdNum,
      description: body.description,
      totalPrice: body.totalPrice,
      itemType: body.itemType ?? 'product',
      amount: body.amount ?? '1.000',
      unit: body.unit ?? null,
      pricePerUnit: body.pricePerUnit ?? null,
      category: body.category ?? null,
      isUserAdded: true,
    });

    await db.update(receipts).set({ editedAt: new Date() }).where(eq(receipts.id, receiptIdNum));

    const [created] = await db.select().from(lineItems).where(eq(lineItems.id, result[0].insertId));
    return reply.status(201).send(created);
  });

  // DELETE /receipts/:uploadId/receipt/:receiptId/line-items/:lineItemId — soft delete
  server.delete('/receipts/:uploadId/receipt/:receiptId/line-items/:lineItemId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId, lineItemId } = request.params as { uploadId: string; receiptId: string; lineItemId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    const lineItemIdNum = parseInt(lineItemId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum) || isNaN(lineItemIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });

    const [item] = await db.select().from(lineItems).where(
      and(eq(lineItems.id, lineItemIdNum), eq(lineItems.receiptId, receiptIdNum), isNull(lineItems.deletedAt)),
    );
    if (!item) return reply.status(404).send({ error: 'Line item not found.' });

    const now = new Date();
    await db.update(lineItems).set({ deletedAt: now }).where(eq(lineItems.id, lineItemIdNum));
    await db.update(receipts).set({ editedAt: now }).where(eq(receipts.id, receiptIdNum));
    await writeHistory('line_item', lineItemIdNum, request.user.id, {
      __deleted__: { oldValue: 'false', newValue: 'true' },
    });

    return reply.send({ message: 'Line item removed.', lineItemId: lineItemIdNum });
  });

  // POST /receipts/:uploadId/receipt/:receiptId/line-items/:lineItemId/reset — reset one item to AI-extracted values
  server.post('/receipts/:uploadId/receipt/:receiptId/line-items/:lineItemId/reset', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId, lineItemId } = request.params as { uploadId: string; receiptId: string; lineItemId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    const lineItemIdNum = parseInt(lineItemId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum) || isNaN(lineItemIdNum)) {
      return reply.status(400).send({ error: 'Invalid ID.' });
    }

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });

    const [item] = await db.select().from(lineItems).where(
      and(eq(lineItems.id, lineItemIdNum), eq(lineItems.receiptId, receiptIdNum), isNull(lineItems.deletedAt)),
    );
    if (!item) return reply.status(404).send({ error: 'Line item not found.' });
    if (item.isUserAdded) return reply.status(409).send({ error: 'User-added items cannot be reset; delete them instead.' });

    const itemHistory = await db.select()
      .from(receiptEditHistory)
      .where(and(
        eq(receiptEditHistory.entityType, 'line_item'),
        eq(receiptEditHistory.entityId, lineItemIdNum),
      ))
      .orderBy(asc(receiptEditHistory.changedAt));

    const originalItem: Record<string, string | null> = {};
    for (const entry of itemHistory) {
      if (!Object.hasOwn(originalItem, entry.fieldName)) {
        originalItem[entry.fieldName] = entry.oldValue;
      }
    }

    const editableFields = ['description', 'amount', 'unit', 'pricePerUnit', 'totalPrice'] as const;
    if (!editableFields.some(f => Object.hasOwn(originalItem, f))) {
      return reply.status(409).send({ error: 'No edits to reset for this item.' });
    }

    const itemRestore: LineItemUpdate = {};
    if (Object.hasOwn(originalItem, 'description') && originalItem.description !== null) {
      itemRestore.description = originalItem.description;
    }
    if (Object.hasOwn(originalItem, 'totalPrice') && originalItem.totalPrice !== null) {
      itemRestore.totalPrice = originalItem.totalPrice;
    }
    if (Object.hasOwn(originalItem, 'amount')) itemRestore.amount = originalItem.amount;
    if (Object.hasOwn(originalItem, 'unit')) itemRestore.unit = originalItem.unit;
    if (Object.hasOwn(originalItem, 'pricePerUnit')) itemRestore.pricePerUnit = originalItem.pricePerUnit;

    await db.update(lineItems).set(itemRestore).where(eq(lineItems.id, lineItemIdNum));

    const [updated] = await db.select().from(lineItems).where(eq(lineItems.id, lineItemIdNum));
    return reply.send(updated);
  });

  // POST /receipts/:uploadId/receipt/:receiptId/approve — mark receipt as reviewed/approved
  server.post('/receipts/:uploadId/receipt/:receiptId/approve', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });

    await db.update(receipts).set({ reviewStatus: 'reviewed' }).where(eq(receipts.id, receiptIdNum));

    const [updated] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    return reply.send(updated);
  });

  // POST /receipts/:uploadId/receipt/:receiptId/unapprove — revert reviewed → needs_review
  server.post('/receipts/:uploadId/receipt/:receiptId/unapprove', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });

    await db.update(receipts).set({ reviewStatus: 'needs_review' }).where(eq(receipts.id, receiptIdNum));

    const [updated] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    return reply.send(updated);
  });

  // DELETE /receipts/:uploadId/receipt/:receiptId — soft-delete a receipt
  server.delete('/receipts/:uploadId/receipt/:receiptId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    // Ownership check only — deletion must be allowed regardless of receipt status
    // (pending/rate_limited receipts would otherwise be undeletable, keeping the upload stuck at partly_completed)
    const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));
    if (!upload) return reply.status(404).send({ error: 'Receipt upload not found.' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden.' });

    const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    if (!receipt || receipt.uploadId !== uploadIdNum) return reply.status(404).send({ error: 'Receipt not found for this upload.' });

    await db.update(receipts).set({ deletedAt: new Date() }).where(eq(receipts.id, receiptIdNum));

    // Clean up duplicate_matches entries involving this receipt.
    // Note: isDuplicate / duplicateOfReceiptId on linked receipts is intentionally preserved so that
    // restoring this receipt automatically re-activates those relationships.
    // The retrieve layer filters effective isDuplicate by checking if the original is deleted.
    await db
      .delete(duplicateMatches)
      .where(or(eq(duplicateMatches.receiptId, receiptIdNum), eq(duplicateMatches.potentialDuplicateId, receiptIdNum)));

    await recalcUploadStatus(uploadIdNum);

    const [updated] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    return reply.send(updated);
  });

  // POST /receipts/:uploadId/receipt/:receiptId/restore — restore a soft-deleted receipt
  server.post('/receipts/:uploadId/receipt/:receiptId/restore', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });

    await db.update(receipts).set({ deletedAt: null }).where(eq(receipts.id, receiptIdNum));
    await recalcUploadStatus(uploadIdNum);

    const [updated] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    return reply.send(updated);
  });

  // POST /receipts/:uploadId/receipt/:receiptId/reset-to-original — reset to AI-extracted values
  server.post('/receipts/:uploadId/receipt/:receiptId/reset-to-original', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });
    const { receipt } = resolved;

    if (!receipt.editedAt) {
      return reply.status(409).send({ error: 'No edits to reset.' });
    }

    // Collect all history entries for this receipt's header fields
    const headerHistory = await db.select()
      .from(receiptEditHistory)
      .where(and(
        eq(receiptEditHistory.entityType, 'receipt'),
        eq(receiptEditHistory.entityId, receiptIdNum),
      ))
      .orderBy(asc(receiptEditHistory.changedAt));

    // First old_value per field = original AI value
    const originalHeader: Record<string, string | null> = {};
    for (const entry of headerHistory) {
      if (!Object.hasOwn(originalHeader, entry.fieldName)) {
        originalHeader[entry.fieldName] = entry.oldValue;
      }
    }

    const headerRestore: ReceiptUpdate = { editedAt: null };
    if (Object.hasOwn(originalHeader, 'storeName')) headerRestore.storeName = originalHeader.storeName;
    if (Object.hasOwn(originalHeader, 'totalAmount')) headerRestore.totalAmount = originalHeader.totalAmount;
    if (Object.hasOwn(originalHeader, 'taxAmount')) headerRestore.taxAmount = originalHeader.taxAmount;
    if (Object.hasOwn(originalHeader, 'currency')) headerRestore.currency = originalHeader.currency;
    if (Object.hasOwn(originalHeader, 'transactionDate')) {
      headerRestore.transactionDate = originalHeader.transactionDate ? new Date(originalHeader.transactionDate) : null;
    }

    await db.update(receipts).set(headerRestore).where(eq(receipts.id, receiptIdNum));

    // Soft-delete user-added line items
    await db.update(lineItems)
      .set({ deletedAt: new Date() })
      .where(and(eq(lineItems.receiptId, receiptIdNum), eq(lineItems.isUserAdded, true)));

    // Restore soft-deleted original line items
    await db.update(lineItems)
      .set({ deletedAt: null })
      .where(and(eq(lineItems.receiptId, receiptIdNum), eq(lineItems.isUserAdded, false)));

    // Restore individual line item fields from history
    const allOriginalItems = await db.select().from(lineItems)
      .where(and(eq(lineItems.receiptId, receiptIdNum), eq(lineItems.isUserAdded, false)));

    for (const item of allOriginalItems) {
      const itemHistory = await db.select()
        .from(receiptEditHistory)
        .where(and(
          eq(receiptEditHistory.entityType, 'line_item'),
          eq(receiptEditHistory.entityId, item.id),
        ))
        .orderBy(asc(receiptEditHistory.changedAt));

      const originalItem: Record<string, string | null> = {};
      for (const entry of itemHistory) {
        if (!Object.hasOwn(originalItem, entry.fieldName)) {
          originalItem[entry.fieldName] = entry.oldValue;
        }
      }

      const itemRestore: LineItemUpdate = {};
      if (Object.hasOwn(originalItem, 'description') && originalItem.description !== null) {
        itemRestore.description = originalItem.description;
      }
      if (Object.hasOwn(originalItem, 'totalPrice') && originalItem.totalPrice !== null) {
        itemRestore.totalPrice = originalItem.totalPrice;
      }
      if (Object.hasOwn(originalItem, 'amount')) itemRestore.amount = originalItem.amount;
      if (Object.hasOwn(originalItem, 'unit')) itemRestore.unit = originalItem.unit;
      if (Object.hasOwn(originalItem, 'pricePerUnit')) itemRestore.pricePerUnit = originalItem.pricePerUnit;

      if (Object.keys(itemRestore).length > 0) {
        await db.update(lineItems).set(itemRestore).where(eq(lineItems.id, item.id));
      }
    }

    // Return the updated receipt with line items
    const [updatedReceipt] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    const updatedItems = await db.select().from(lineItems)
      .where(and(eq(lineItems.receiptId, receiptIdNum), isNull(lineItems.deletedAt)));

    return reply.send({ ...updatedReceipt, lineItems: updatedItems });
  });

  // POST /receipts/:uploadId/receipt/:receiptId/replace-image — replace receipt photo and re-run OCR
  server.post('/receipts/:uploadId/receipt/:receiptId/replace-image', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'User not authenticated.' });

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);
    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) return reply.status(400).send({ error: 'Invalid ID.' });

    const resolved = await resolveReceiptForEdit(uploadIdNum, receiptIdNum, request.user.id);
    if ('error' in resolved) return reply.status(resolved.statusCode).send({ error: resolved.error });
    const { receipt, upload } = resolved;

    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'Image file is required.' });

    const buffer = await data.toBuffer();
    const compressed = await compressToWebP(buffer);
    const filename = hashFilename(compressed, '.webp');
    const { publicUrl } = await saveFile(compressed, filename);

    // Preserve old image URL in edit history for training data lineage
    const oldImageUrl = receipt.imageUrl ?? null;
    await writeHistory('receipt', receiptIdNum, request.user.id, {
      imageUrl: { oldValue: oldImageUrl, newValue: publicUrl },
    });

    await db.update(receipts).set({
      imageUrl: publicUrl,
      editedAt: new Date(),
      reviewStatus: 'needs_review',
      status: 'pending',
    }).where(eq(receipts.id, receiptIdNum));

    await db.update(receiptUploads)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(receiptUploads.id, uploadIdNum));

    const uploadFilename = path.basename(upload.originalImageUrl);
    const jobData: ReceiptJobData = {
      uploadId: uploadIdNum,
      imagePath: path.join(UPLOADS_DIR, uploadFilename),
      receiptId: receiptIdNum,
      receiptImagePath: path.join(UPLOADS_DIR, filename),
    };
    await receiptProcessingQueue.add('process-single-receipt', jobData, {
      jobId: `receipt-${receiptIdNum}-retake-${Date.now()}`,
    });

    const [updated] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
    return reply.status(202).send(updated);
  });
}
