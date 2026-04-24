import { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import { lineItems, processingErrors, receiptEditHistory, receiptUploads, receipts } from '../../../db/schema.js';

/** Resolve duplicate-source info for a batch of receipts in two queries. */
async function resolveDuplicateSources(receiptRows: { id: number; isDuplicate: boolean | null; duplicateOfReceiptId: number | null }[]): Promise<Map<number, { deletedAt: Date | null; uploadId: number; userReceiptNumber: number; uploadNumber: number }>> {
  const sourceIds = [...new Set(
    receiptRows
      .filter(r => r.isDuplicate && r.duplicateOfReceiptId)
      .map(r => r.duplicateOfReceiptId!)
  )];
  if (sourceIds.length === 0) return new Map();

  const sourceReceipts = await db
    .select({ id: receipts.id, deletedAt: receipts.deletedAt, uploadId: receipts.uploadId, userReceiptNumber: receipts.userReceiptNumber })
    .from(receipts)
    .where(inArray(receipts.id, sourceIds));

  const uploadIds = [...new Set(sourceReceipts.map(r => r.uploadId))];
  const uploadRows = uploadIds.length > 0
    ? await db.select({ id: receiptUploads.id, uploadNumber: receiptUploads.uploadNumber }).from(receiptUploads).where(inArray(receiptUploads.id, uploadIds))
    : [];
  const uploadNumberMap = new Map(uploadRows.map(u => [u.id, u.uploadNumber]));

  return new Map(sourceReceipts.map(r => [r.id, { ...r, uploadNumber: uploadNumberMap.get(r.uploadId) ?? 0 }]));
}

function computeDuplicateFields(receipt: { isDuplicate: boolean | null; duplicateOfReceiptId: number | null }, sourceMap: Map<number, { deletedAt: Date | null; uploadId: number; userReceiptNumber: number; uploadNumber: number }>) {
  if (!receipt.isDuplicate || !receipt.duplicateOfReceiptId) {
    return { isDuplicate: false, duplicateOfReceiptId: null, duplicateOfUploadNumber: null, duplicateOfReceiptNumber: null };
  }
  const src = sourceMap.get(receipt.duplicateOfReceiptId);
  if (!src || src.deletedAt) {
    // Original is deleted or not found — suppress the duplicate flag
    return { isDuplicate: false, duplicateOfReceiptId: null, duplicateOfUploadNumber: null, duplicateOfReceiptNumber: null };
  }
  return {
    isDuplicate: true,
    duplicateOfReceiptId: receipt.duplicateOfReceiptId,
    duplicateOfUploadNumber: src.uploadNumber,
    duplicateOfReceiptNumber: src.userReceiptNumber,
  };
}

/**
 * GET endpoints for receipt uploads and individual receipts.
 * Read-only; all writes live in upload.ts / reprocess.ts / delete.ts.
 */
export default async function retrieveRoutes(server: FastifyInstance) {
  // GET receipt upload by ID with all receipts and metadata
  server.get('/receipts/:uploadId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const { uploadId } = request.params as { uploadId: string };
    const uploadIdNum = parseInt(uploadId, 10);

    if (isNaN(uploadIdNum)) {
      return reply.status(400).send({ error: 'Invalid upload ID.' });
    }

    const [upload] = await db
      .select()
      .from(receiptUploads)
      .where(eq(receiptUploads.id, uploadIdNum));

    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }

    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    const receiptsList = await db
      .select()
      .from(receipts)
      .where(eq(receipts.uploadId, uploadIdNum));

    const errors = await db
      .select()
      .from(processingErrors)
      .where(eq(processingErrors.uploadId, uploadIdNum));

    const duplicateSourceMap = await resolveDuplicateSources(receiptsList);

    const receiptsWithItems = await Promise.all(
      receiptsList.map(async (receipt) => {
        const items = await db
          .select()
          .from(lineItems)
          .where(and(eq(lineItems.receiptId, receipt.id), isNull(lineItems.deletedAt)));

        const dupFields = computeDuplicateFields(receipt, duplicateSourceMap);

        return {
          id: receipt.id,
          uploadId: receipt.uploadId,
          storeName: receipt.storeName,
          totalAmount: receipt.totalAmount,
          taxAmount: receipt.taxAmount,
          transactionDate: receipt.transactionDate,
          currency: receipt.currency,
          status: receipt.status,
          reviewStatus: receipt.reviewStatus,
          imageUrl: receipt.imageUrl,
          ocrText: receipt.ocrText,
          keywords: receipt.keywords,
          ...dupFields,
          duplicateConfidenceScore: receipt.duplicateConfidenceScore,
          processingMetadata: receipt.processingMetadata,
          editedAt: receipt.editedAt,
          itemsNonReadable: receipt.itemsNonReadable,
          deletedAt: receipt.deletedAt,
          lineItems: items.map((item) => ({ ...item, isUserAdded: item.isUserAdded })),
        };
      }),
    );

    // Rate-limited receipts have their own DB status ('rate_limited').
    // processing_errors still surfaces reset times for the UI.
    const rateLimitedErrors = errors.filter((e) => {
      const meta = e.metadata as { errorType?: string } | null;
      return meta?.errorType === 'RATE_LIMITED';
    });
    const rateLimitedReceiptIds = new Set(
      receiptsList.filter((r) => r.status === 'rate_limited').map((r) => r.id),
    );

    const activeReceipts = receiptsList.filter((r) => !r.deletedAt);
    const totalDetected = activeReceipts.length;
    const successfulCount = activeReceipts.filter((r) => r.status === 'processed').length;
    const needsReviewCount = activeReceipts.filter((r) => r.reviewStatus === 'needs_review').length;
    const failedCount = activeReceipts.filter((r) => r.status === 'failed' || r.status === 'unreadable').length;
    const processingCount = activeReceipts.filter((r) => r.status === 'pending').length;
    const deletedCount = receiptsList.filter((r) => !!r.deletedAt).length;
    const rateLimitedCount = rateLimitedReceiptIds.size;

    // Latest reset time and provider across all rate-limited errors.
    let resumableAt: string | null = null;
    let rateLimitProvider: string | null = null;
    for (const e of rateLimitedErrors) {
      const meta = e.metadata as { resetTime?: string; provider?: string } | null;
      if (meta?.resetTime) {
        if (!resumableAt || new Date(meta.resetTime) > new Date(resumableAt)) {
          resumableAt = meta.resetTime;
        }
      }
      if (meta?.provider && !rateLimitProvider) {
        rateLimitProvider = meta.provider;
      }
    }
    const rateLimited = rateLimitedReceiptIds.size > 0
      ? {
          count: rateLimitedReceiptIds.size,
          resumableAt,
          provider: rateLimitProvider,
          message:
            'Some receipts could not be processed because the AI rate limit was reached. You can resume processing once the limit resets.',
        }
      : null;

    const successfulReceipts = receiptsWithItems.filter(
      (r) => r.status === 'processed' && (r.reviewStatus === 'not_required' || r.reviewStatus === 'reviewed'),
    );
    const needsReviewReceipts = receiptsWithItems.filter((r) => r.reviewStatus === 'needs_review');
    const failedReceipts = receiptsWithItems.filter((r) => r.status === 'failed' || r.status === 'unreadable');
    const processingReceipts = receiptsWithItems.filter((r) => r.status === 'pending');
    const rateLimitedReceipts = receiptsWithItems.filter((r) => r.status === 'rate_limited');

    const splitReceiptImages = receiptsList.map((r) => r.imageUrl).filter((url) => url !== null);

    return reply.send({
      uploadId: upload.id,
      uploadNumber: upload.uploadNumber,
      userId: upload.userId,
      status: upload.status,
      hasReceipts: upload.hasReceipts === 1,
      createdAt: upload.createdAt,
      updatedAt: upload.updatedAt,

      images: {
        original: upload.originalImageUrl,
        marked: upload.markedImageUrl,
        splitReceipts: splitReceiptImages,
      },

      statistics: {
        totalDetected,
        successful: successfulCount,
        failed: failedCount,
        processing: processingCount,
        rateLimited: rateLimitedCount,
        needsReview: needsReviewCount,
        deleted: deletedCount,
      },

      message:
        upload.status === 'processing'
          ? totalDetected === 0
            ? 'Detecting receipts in image...'
            : processingCount > 0
            ? `Analyzing receipts. ${successfulCount + failedCount} of ${totalDetected} done, ${processingCount} remaining.`
            : `Finalizing processing for ${totalDetected} receipt${totalDetected !== 1 ? 's' : ''}.`
          : upload.status === 'completed'
          ? `Processing complete. ${successfulCount} succeeded, ${failedCount} failed.`
          : upload.status === 'partly_completed'
          ? `Processing partly completed. ${successfulCount} succeeded, ${failedCount} failed, ${processingCount} still processing.`
          : upload.status === 'failed'
          ? 'Processing failed.'
          : upload.status === 'duplicate'
          ? 'Duplicate upload detected. This image was already uploaded.'
          : 'Unknown status.',

      receipts: {
        successful: successfulReceipts,
        needsReview: needsReviewReceipts,
        failed: failedReceipts,
        processing: processingReceipts,
        rateLimited: rateLimitedReceipts,
        all: receiptsWithItems,
      },

      errors,
      rateLimited,
    });
  });

  // GET individual receipt with originals map (first old_value per field from edit history)
  server.get('/receipts/:uploadId/receipt/:receiptId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
    const uploadIdNum = parseInt(uploadId, 10);
    const receiptIdNum = parseInt(receiptId, 10);

    if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) {
      return reply.status(400).send({ error: 'Invalid upload ID or receipt ID.' });
    }

    const [upload] = await db
      .select()
      .from(receiptUploads)
      .where(eq(receiptUploads.id, uploadIdNum));

    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }

    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptIdNum));

    if (!receipt) {
      return reply.status(404).send({ error: 'Receipt not found.' });
    }

    if (receipt.uploadId !== uploadIdNum) {
      return reply.status(400).send({ error: 'Receipt does not belong to the specified upload.' });
    }

    const items = await db
      .select()
      .from(lineItems)
      .where(and(eq(lineItems.receiptId, receiptIdNum), isNull(lineItems.deletedAt)));

    const historyEntries = await db
      .select()
      .from(receiptEditHistory)
      .where(
        and(eq(receiptEditHistory.entityType, 'receipt'), eq(receiptEditHistory.entityId, receiptIdNum)),
      )
      .orderBy(asc(receiptEditHistory.changedAt));

    const originals: Record<string, string | null> = {};
    for (const entry of historyEntries) {
      if (!Object.hasOwn(originals, entry.fieldName)) {
        originals[entry.fieldName] = entry.oldValue;
      }
    }

    const itemOriginals: Record<number, Record<string, string | null>> = {};
    if (items.length > 0) {
      const itemHistoryEntries = await db
        .select()
        .from(receiptEditHistory)
        .where(
          and(
            eq(receiptEditHistory.entityType, 'line_item'),
            inArray(
              receiptEditHistory.entityId,
              items.map((i) => i.id),
            ),
          ),
        )
        .orderBy(asc(receiptEditHistory.changedAt));

      for (const entry of itemHistoryEntries) {
        if (!itemOriginals[entry.entityId]) itemOriginals[entry.entityId] = {};
        if (!Object.hasOwn(itemOriginals[entry.entityId], entry.fieldName)) {
          itemOriginals[entry.entityId][entry.fieldName] = entry.oldValue;
        }
      }
    }

    const dupSourceMap = await resolveDuplicateSources([receipt]);
    const dupFields = computeDuplicateFields(receipt, dupSourceMap);

    return reply.send({
      id: receipt.id,
      uploadId: receipt.uploadId,
      storeName: receipt.storeName,
      totalAmount: receipt.totalAmount,
      taxAmount: receipt.taxAmount,
      transactionDate: receipt.transactionDate,
      currency: receipt.currency,
      status: receipt.status,
      reviewStatus: receipt.reviewStatus,
      imageUrl: receipt.imageUrl,
      ocrText: receipt.ocrText,
      keywords: receipt.keywords,
      ...dupFields,
      duplicateConfidenceScore: receipt.duplicateConfidenceScore,
      processingMetadata: receipt.processingMetadata,
      editedAt: receipt.editedAt,
      originals: Object.keys(originals).length > 0 ? originals : null,
      itemOriginals: Object.keys(itemOriginals).length > 0 ? itemOriginals : null,
      lineItems: items.map((item) => ({ ...item, isUserAdded: item.isUserAdded })),
    });
  });
}
