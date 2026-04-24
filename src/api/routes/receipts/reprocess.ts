import { FastifyInstance } from 'fastify';
import path from 'path';
import { eq, or } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import { duplicateMatches, lineItems, processingErrors, receiptUploads, receipts } from '../../../db/schema.js';
import { ReceiptJobData, receiptProcessingQueue } from '../../../queue/index.js';
import { UPLOADS_DIR, deleteFile } from '../../../utils/file-utils.js';
import { overrideDuplicateFlag } from '../../../services/duplicate-detector.js';
import { resumeRateLimitedReceipts } from '../../../services/resumeProcessing.js';

/**
 * Endpoints that modify an existing upload without creating a new one:
 * - reprocess a single receipt
 * - resume rate-limited receipts
 * - reprocess a whole upload (clears children, re-runs splitter)
 * - override duplicate flag on a single receipt
 *
 * All of these enqueue BullMQ jobs with unique jobIds (BullMQ silently rejects
 * duplicate jobIds, so suffixing with Date.now() prevents a reprocess from
 * being swallowed if the original job's record still exists).
 */
export default async function reprocessRoutes(server: FastifyInstance) {
  // Re-process a single receipt (user-triggered retry)
  server.post(
    '/receipts/:uploadId/receipt/:receiptId/reprocess',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'User not authenticated.' });
      }

      const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
      const uploadIdNum = parseInt(uploadId, 10);
      const receiptIdNum = parseInt(receiptId, 10);

      if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) {
        return reply.status(400).send({ error: 'Invalid upload ID or receipt ID.' });
      }

      const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));
      if (!upload) {
        return reply.status(404).send({ error: 'Receipt upload not found.' });
      }
      if (upload.userId !== request.user.id) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }

      const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
      if (!receipt || receipt.uploadId !== uploadIdNum) {
        return reply.status(404).send({ error: 'Receipt not found for this upload.' });
      }

      await db.delete(lineItems).where(eq(lineItems.receiptId, receiptIdNum));
      await db
        .delete(duplicateMatches)
        .where(
          or(
            eq(duplicateMatches.receiptId, receiptIdNum),
            eq(duplicateMatches.potentialDuplicateId, receiptIdNum),
          ),
        );

      const existingErrors = await db
        .select()
        .from(processingErrors)
        .where(eq(processingErrors.uploadId, uploadIdNum));
      for (const error of existingErrors) {
        if (error.receiptId === receiptIdNum) {
          await db.delete(processingErrors).where(eq(processingErrors.id, error.id));
        }
      }

      // Reset receipt status (also clears 'rate_limited')
      await db
        .update(receipts)
        .set({
          status: 'pending',
          reviewStatus: 'not_required',
          storeName: null,
          totalAmount: null,
          taxAmount: null,
          transactionDate: null,
          currency: null,
          keywords: null,
          isDuplicate: false,
          duplicateOfReceiptId: null,
          duplicateConfidenceScore: null,
          duplicateCheckedAt: null,
          duplicateOverride: false,
          processingMetadata: null,
        })
        .where(eq(receipts.id, receiptIdNum));

      await db
        .update(receiptUploads)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(eq(receiptUploads.id, uploadIdNum));

      const uploadFilename = path.basename(upload.originalImageUrl);
      const receiptFilename = receipt.imageUrl ? path.basename(receipt.imageUrl) : '';
      const jobData: ReceiptJobData = {
        uploadId: uploadIdNum,
        imagePath: path.join(UPLOADS_DIR, uploadFilename),
        receiptId: receiptIdNum,
        receiptImagePath: receiptFilename ? path.join(UPLOADS_DIR, receiptFilename) : '',
      };
      await receiptProcessingQueue.add('process-single-receipt', jobData, {
        jobId: `receipt-${receiptIdNum}-reprocess-${Date.now()}`,
      });

      return reply.status(202).send({
        uploadId: uploadIdNum,
        receiptId: receiptIdNum,
        message: 'Single receipt reprocessing has been queued.',
        statusUrl: `/receipts/${uploadIdNum}/receipt/${receiptIdNum}`,
      });
    },
  );

  // Resume rate-limited receipts. Safe to call repeatedly — if the quota
  // hasn't reset, the new jobs will just hit the limit again.
  server.post('/receipts/:uploadId/resume', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const { uploadId } = request.params as { uploadId: string };
    const uploadIdNum = parseInt(uploadId, 10);

    if (isNaN(uploadIdNum)) {
      return reply.status(400).send({ error: 'Invalid upload ID.' });
    }

    const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));
    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }
    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    const resumedCount = await resumeRateLimitedReceipts(uploadIdNum);

    if (resumedCount === 0) {
      return reply.status(400).send({ error: 'No rate-limited receipts found to resume.' });
    }

    return reply.status(202).send({
      uploadId: uploadIdNum,
      resumedReceiptCount: resumedCount,
      message: `Queued ${resumedCount} rate-limited receipt(s) for reprocessing.`,
      statusUrl: `/receipts/${uploadIdNum}`,
    });
  });

  // User override — tell the system a flagged duplicate is actually unique.
  server.post(
    '/receipts/:uploadId/receipt/:receiptId/duplicate-override',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'User not authenticated.' });
      }

      const { uploadId, receiptId } = request.params as { uploadId: string; receiptId: string };
      const uploadIdNum = parseInt(uploadId, 10);
      const receiptIdNum = parseInt(receiptId, 10);

      if (isNaN(uploadIdNum) || isNaN(receiptIdNum)) {
        return reply.status(400).send({ error: 'Invalid upload ID or receipt ID.' });
      }

      const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));
      if (!upload) {
        return reply.status(404).send({ error: 'Receipt upload not found.' });
      }
      if (upload.userId !== request.user.id) {
        return reply.status(403).send({ error: 'Forbidden.' });
      }

      const [receipt] = await db.select().from(receipts).where(eq(receipts.id, receiptIdNum));
      if (!receipt || receipt.uploadId !== uploadIdNum) {
        return reply.status(404).send({ error: 'Receipt not found for this upload.' });
      }

      await overrideDuplicateFlag(receiptIdNum);

      return reply.send({ message: 'Duplicate flag removed', receiptId: receiptIdNum });
    },
  );

  // Reprocess a whole upload: wipes children + marked image, re-queues split.
  server.post('/receipts/:uploadId/reprocess', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const { uploadId } = request.params as { uploadId: string };
    const uploadIdNum = parseInt(uploadId, 10);

    if (isNaN(uploadIdNum)) {
      return reply.status(400).send({ error: 'Invalid upload ID.' });
    }

    const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));
    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }
    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }
    if (upload.status === 'duplicate') {
      return reply.status(400).send({ error: 'Cannot reprocess a duplicate upload.' });
    }

    const filename = path.basename(upload.originalImageUrl);
    const imagePath = path.join(UPLOADS_DIR, filename);

    const existingReceipts = await db.select().from(receipts).where(eq(receipts.uploadId, uploadIdNum));
    for (const receipt of existingReceipts) {
      await db.delete(lineItems).where(eq(lineItems.receiptId, receipt.id));
      await db
        .delete(duplicateMatches)
        .where(
          or(
            eq(duplicateMatches.receiptId, receipt.id),
            eq(duplicateMatches.potentialDuplicateId, receipt.id),
          ),
        );
      if (receipt.imageUrl) {
        await deleteFile(receipt.imageUrl);
      }
    }

    await db.delete(receipts).where(eq(receipts.uploadId, uploadIdNum));
    await db.delete(processingErrors).where(eq(processingErrors.uploadId, uploadIdNum));

    if (upload.markedImageUrl) {
      await deleteFile(upload.markedImageUrl);
    }

    await db
      .update(receiptUploads)
      .set({
        status: 'processing',
        markedImageUrl: null,
        hasReceipts: null,
        updatedAt: new Date(),
      })
      .where(eq(receiptUploads.id, uploadIdNum));

    const jobData: ReceiptJobData = {
      uploadId: uploadIdNum,
      imagePath,
    };
    await receiptProcessingQueue.add('process-receipt', jobData, {
      jobId: `upload-${uploadIdNum}-reprocess-${Date.now()}`,
    });

    return reply.status(202).send({
      uploadId: uploadIdNum,
      message: 'Receipt reprocessing has been queued.',
      statusUrl: `/receipts/${uploadIdNum}`,
    });
  });
}
