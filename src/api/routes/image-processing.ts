import { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { authenticate } from '../auth.js';
import { receiptProcessingQueue, ReceiptJobData } from '../../queue/index.js';
import { db } from '../../db/index.js';
import { receiptUploads, receipts, lineItems, processingErrors, duplicateMatches } from '../../db/schema.js';
import { eq, and, or, sql } from 'drizzle-orm';
import { saveFile, compressToWebP, deleteFile, UPLOADS_DIR } from '../../utils/file-utils.js';
import { overrideDuplicateFlag } from '../../services/duplicate-detector.js';
import { ReceiptAnalysisService } from '../../services/receipt-analysis.js';
import path from 'path';

export default async function imageProcessingRoutes(server: FastifyInstance) {

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

    // Get the upload record
    const [upload] = await db
      .select()
      .from(receiptUploads)
      .where(eq(receiptUploads.id, uploadIdNum));

    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }

    // Check authorization - user can only access their own uploads
    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    // Get all receipts for this upload
    const receiptsList = await db
      .select()
      .from(receipts)
      .where(eq(receipts.uploadId, uploadIdNum));

    // Get any processing errors
    const errors = await db
      .select()
      .from(processingErrors)
      .where(eq(processingErrors.uploadId, uploadIdNum));

    // Get line items for all receipts
    const receiptsWithItems = await Promise.all(
      receiptsList.map(async (receipt) => {
        const items = await db
          .select()
          .from(lineItems)
          .where(eq(lineItems.receiptId, receipt.id));

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
          isDuplicate: receipt.isDuplicate,
          duplicateOfReceiptId: receipt.duplicateOfReceiptId,
          duplicateConfidenceScore: receipt.duplicateConfidenceScore,
          processingMetadata: receipt.processingMetadata,
          lineItems: items,
        };
      })
    );

    // Rate-limited receipts have their own DB status now ('rate_limited').
    // We still read processing_errors to surface reset times for the UI.
    const rateLimitedErrors = errors.filter((e) => {
      const meta = e.metadata as { errorType?: string } | null;
      return meta?.errorType === 'RATE_LIMITED';
    });
    const rateLimitedReceiptIds = new Set(
      receiptsList.filter(r => r.status === 'rate_limited').map(r => r.id)
    );

    // Calculate statistics
    const totalDetected = receiptsList.length;
    const successfulCount = receiptsList.filter(r => r.status === 'processed').length;
    const needsReviewCount = receiptsList.filter(r => r.reviewStatus === 'needs_review').length;
    const failedCount = receiptsList.filter(r => r.status === 'failed' || r.status === 'unreadable').length;
    const processingCount = receiptsList.filter(r => r.status === 'pending').length;
    const rateLimitedCount = rateLimitedReceiptIds.size;
    // Pick the latest reset time across all rate-limited errors so the UI knows
    // when the resume button can be enabled.
    let resumableAt: string | null = null;
    for (const e of rateLimitedErrors) {
      const meta = e.metadata as { resetTime?: string } | null;
      if (meta?.resetTime) {
        if (!resumableAt || new Date(meta.resetTime) > new Date(resumableAt)) {
          resumableAt = meta.resetTime;
        }
      }
    }
    const rateLimited = rateLimitedReceiptIds.size > 0
      ? {
          count: rateLimitedReceiptIds.size,
          resumableAt,
          message: 'Some receipts could not be processed because the AI rate limit was reached. You can resume processing once the limit resets.',
        }
      : null;

    // Separate receipts by status
    const successfulReceipts = receiptsWithItems.filter(r => r.status === 'processed' && r.reviewStatus === 'not_required');
    const needsReviewReceipts = receiptsWithItems.filter(r => r.reviewStatus === 'needs_review');
    const failedReceipts = receiptsWithItems.filter(r => r.status === 'failed' || r.status === 'unreadable');
    const processingReceipts = receiptsWithItems.filter(r => r.status === 'pending');
    const rateLimitedReceipts = receiptsWithItems.filter(r => r.status === 'rate_limited');

    // Get all split receipt image URLs
    const splitReceiptImages = receiptsList.map(r => r.imageUrl).filter(url => url !== null);

    // Build comprehensive response
    return reply.send({
      uploadId: upload.id,
      uploadNumber: upload.uploadNumber,
      userId: upload.userId,
      status: upload.status,
      hasReceipts: upload.hasReceipts === 1,
      createdAt: upload.createdAt,
      updatedAt: upload.updatedAt,
      
      // Image URLs
      images: {
        original: upload.originalImageUrl,
        marked: upload.markedImageUrl, // Image with detection rectangles
        splitReceipts: splitReceiptImages, // Array of individual receipt images
      },

      // Processing statistics
      statistics: {
        totalDetected: totalDetected,
        successful: successfulCount,
        failed: failedCount,
        processing: processingCount,
        rateLimited: rateLimitedCount,
        needsReview: needsReviewCount,
      },

      // Status message
      message: upload.status === 'processing'
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

      // Receipts grouped by status
      receipts: {
        successful: successfulReceipts,
        needsReview: needsReviewReceipts,
        failed: failedReceipts,
        processing: processingReceipts,
        rateLimited: rateLimitedReceipts,
        all: receiptsWithItems,
      },

      // Processing errors
      errors: errors,

      // Rate limit info: present only when one or more receipts were skipped
      // due to AI rate limits. Frontend should show a "Resume processing"
      // button that becomes enabled at `resumableAt`.
      rateLimited,
    });
  });

  // GET individual receipt by ID
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

    // Get the upload record first to verify ownership
    const [upload] = await db
      .select()
      .from(receiptUploads)
      .where(eq(receiptUploads.id, uploadIdNum));

    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }

    // Check authorization
    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    // Get the specific receipt
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptIdNum));

    if (!receipt) {
      return reply.status(404).send({ error: 'Receipt not found.' });
    }

    // Verify receipt belongs to the specified upload
    if (receipt.uploadId !== uploadIdNum) {
      return reply.status(400).send({ error: 'Receipt does not belong to the specified upload.' });
    }

    // Get line items for this receipt
    const items = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.receiptId, receiptIdNum));

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
      isDuplicate: receipt.isDuplicate,
      duplicateOfReceiptId: receipt.duplicateOfReceiptId,
      duplicateConfidenceScore: receipt.duplicateConfidenceScore,
      processingMetadata: receipt.processingMetadata,
      lineItems: items,
    });
  });

  server.post('/image/split-and-analyze', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
        return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const data = await request.file();
    if (!data) {
        return reply.status(400).send({ error: 'File upload is required.' });
    }

    const imageBuffer = await data.toBuffer();

    // Compute SHA-256 hash of the image for duplicate upload detection
    const imageHash = createHash('sha256').update(imageBuffer).digest('hex');

    // Check for existing upload with the same hash for this user
    const [existingUpload] = await db
      .select({ id: receiptUploads.id, status: receiptUploads.status })
      .from(receiptUploads)
      .where(and(
        eq(receiptUploads.userId, request.user.id),
        eq(receiptUploads.imageHash, imageHash)
      ));

    // Get next upload number for this user
    const [{ maxNum }] = await db
      .select({ maxNum: sql<number>`COALESCE(MAX(${receiptUploads.uploadNumber}), 0)` })
      .from(receiptUploads)
      .where(eq(receiptUploads.userId, request.user.id));
    const uploadNumber = maxNum + 1;

    // Compress for storage and processing — this is what the worker always uses
    const compressedBuffer = await compressToWebP(imageBuffer);
    const { filePath, publicUrl: originalImageUrl } = await saveFile(compressedBuffer, 'upload.webp');

    if (existingUpload) {
      // Duplicate — save the compressed copy for display but no raw original (it won't be processed)
      const insertResult = await db.insert(receiptUploads).values({
        userId: request.user.id,
        uploadNumber,
        originalImageUrl,
        imageHash,
        status: 'duplicate',
        updatedAt: new Date(),
      });
      const uploadId = insertResult[0].insertId;

      return reply.status(202).send({
        uploadId,
        uploadNumber,
        message: 'Duplicate upload detected',
        duplicateOfUploadId: existingUpload.id,
        statusUrl: `/receipts/${uploadId}`,
      });
    }

    // Save the original file before compression for archival (can be cleaned up later via settings)
    const originalExt = data.filename ? (path.extname(data.filename) || '.jpg') : '.jpg';
    const { publicUrl: rawImageUrl } = await saveFile(imageBuffer, `raw${originalExt}`);

    // 1. Create the master upload job record
    const insertResult = await db.insert(receiptUploads).values({
        userId: request.user.id,
        uploadNumber,
        originalImageUrl,
        rawImageUrl,
        imageHash,
        status: 'processing',
        updatedAt: new Date()
    });
    const uploadId = insertResult[0].insertId;

    // 2. Add a job to the queue for background processing
    const jobData: ReceiptJobData = {
        uploadId,
        imagePath: filePath,
    };
    await receiptProcessingQueue.add('process-receipt', jobData, {
      jobId: `upload-${uploadId}`,
    });

    // 3. Respond to the user immediately
    return reply.status(202).send({
        uploadId,
        uploadNumber,
        message: 'Upload successful. Receipt processing has been queued.',
        statusUrl: `/receipts/${uploadId}`,
    });
  });

  // POST endpoint to re-trigger processing for a single receipt
  server.post('/receipts/:uploadId/receipt/:receiptId/reprocess', { preHandler: [authenticate] }, async (request, reply) => {
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

    if (!receipt || receipt.uploadId !== uploadIdNum) {
      return reply.status(404).send({ error: 'Receipt not found for this upload.' });
    }

    // Delete line items for this receipt
    await db.delete(lineItems).where(eq(lineItems.receiptId, receiptIdNum));

    // Delete duplicate matches referencing this receipt
    await db.delete(duplicateMatches).where(
      or(
        eq(duplicateMatches.receiptId, receiptIdNum),
        eq(duplicateMatches.potentialDuplicateId, receiptIdNum)
      )
    );

    // Delete processing errors for this receipt
    const existingErrors = await db
      .select()
      .from(processingErrors)
      .where(eq(processingErrors.uploadId, uploadIdNum));

    for (const error of existingErrors) {
      if (error.receiptId === receiptIdNum) {
        await db.delete(processingErrors).where(eq(processingErrors.id, error.id));
      }
    }

    // Reset receipt status to pending (also clears 'rate_limited')
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

    // Update upload status to processing
    await db
      .update(receiptUploads)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(receiptUploads.id, uploadIdNum));

    // Queue reprocessing job for the single receipt
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
  });

  // POST endpoint to resume processing of receipts that were skipped due to
  // AI rate limits. Re-queues each pending receipt with a RATE_LIMITED error
  // as an individual single-receipt job. Safe to call repeatedly — if the
  // rate limit window hasn't reset yet, the new jobs will simply hit the
  // limit again and be re-queued.
  server.post('/receipts/:uploadId/resume', { preHandler: [authenticate] }, async (request, reply) => {
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

    const errorsForUpload = await db
      .select()
      .from(processingErrors)
      .where(eq(processingErrors.uploadId, uploadIdNum));

    const rateLimitedReceiptIds = new Set(
      errorsForUpload
        .filter((e) => {
          const meta = e.metadata as { errorType?: string } | null;
          return meta?.errorType === 'RATE_LIMITED' && e.receiptId !== null;
        })
        .map((e) => e.receiptId as number)
    );

    if (rateLimitedReceiptIds.size === 0) {
      return reply.status(400).send({ error: 'No rate-limited receipts to resume on this upload.' });
    }

    const allReceiptsForUpload = await db
      .select()
      .from(receipts)
      .where(eq(receipts.uploadId, uploadIdNum));

    const toResume = allReceiptsForUpload.filter(
      (r) => rateLimitedReceiptIds.has(r.id) && r.status === 'rate_limited'
    );

    if (toResume.length === 0) {
      return reply.status(400).send({ error: 'No rate-limited receipts found to resume.' });
    }

    // Reset their status back to 'pending' so the worker picks them up
    for (const receipt of toResume) {
      await db.update(receipts)
        .set({ status: 'pending' })
        .where(eq(receipts.id, receipt.id));
    }

    // Clear stale RATE_LIMITED errors before re-queueing so they don't pile up
    for (const error of errorsForUpload) {
      const meta = error.metadata as { errorType?: string } | null;
      if (meta?.errorType === 'RATE_LIMITED' && error.receiptId && rateLimitedReceiptIds.has(error.receiptId)) {
        await db.delete(processingErrors).where(eq(processingErrors.id, error.id));
      }
    }

    // Re-queue each as a single-receipt job
    const uploadFilename = path.basename(upload.originalImageUrl);
    for (const receipt of toResume) {
      const receiptFilename = receipt.imageUrl ? path.basename(receipt.imageUrl) : '';
      const jobData: ReceiptJobData = {
        uploadId: uploadIdNum,
        imagePath: path.join(UPLOADS_DIR, uploadFilename),
        receiptId: receipt.id,
        receiptImagePath: receiptFilename ? path.join(UPLOADS_DIR, receiptFilename) : '',
      };
      await receiptProcessingQueue.add('process-single-receipt', jobData, {
        jobId: `receipt-${receipt.id}-resume-${Date.now()}`,
      });
    }

    await db
      .update(receiptUploads)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(receiptUploads.id, uploadIdNum));

    return reply.status(202).send({
      uploadId: uploadIdNum,
      resumedReceiptCount: toResume.length,
      message: `Queued ${toResume.length} rate-limited receipt(s) for reprocessing.`,
      statusUrl: `/receipts/${uploadIdNum}`,
    });
  });

  // POST endpoint to override duplicate flag on a receipt
  server.post('/receipts/:uploadId/receipt/:receiptId/duplicate-override', { preHandler: [authenticate] }, async (request, reply) => {
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

    if (!receipt || receipt.uploadId !== uploadIdNum) {
      return reply.status(404).send({ error: 'Receipt not found for this upload.' });
    }

    await overrideDuplicateFlag(receiptIdNum);

    return reply.send({ message: 'Duplicate flag removed', receiptId: receiptIdNum });
  });

  // POST endpoint to re-trigger processing for an existing upload
  server.post('/receipts/:uploadId/reprocess', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const { uploadId } = request.params as { uploadId: string };
    const uploadIdNum = parseInt(uploadId, 10);

    if (isNaN(uploadIdNum)) {
      return reply.status(400).send({ error: 'Invalid upload ID.' });
    }

    // Get the upload record
    const [upload] = await db
      .select()
      .from(receiptUploads)
      .where(eq(receiptUploads.id, uploadIdNum));

    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }

    // Check authorization - user can only reprocess their own uploads
    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    if (upload.status === 'duplicate') {
      return reply.status(400).send({ error: 'Cannot reprocess a duplicate upload.' });
    }

    // Extract filename from public URL (e.g. "/files/abc123.jpg" → "abc123.jpg")
    // and resolve to actual filesystem path in the uploads directory
    const filename = path.basename(upload.originalImageUrl);
    const imagePath = path.join(UPLOADS_DIR, filename);

    // Delete existing receipts, line items, and their image files
    const existingReceipts = await db
      .select()
      .from(receipts)
      .where(eq(receipts.uploadId, uploadIdNum));

    for (const receipt of existingReceipts) {
      await db.delete(lineItems).where(eq(lineItems.receiptId, receipt.id));
      await db.delete(duplicateMatches).where(
        or(
          eq(duplicateMatches.receiptId, receipt.id),
          eq(duplicateMatches.potentialDuplicateId, receipt.id)
        )
      );
      if (receipt.imageUrl) {
        await deleteFile(receipt.imageUrl);
      }
    }

    // Delete all receipts for this upload
    await db.delete(receipts).where(eq(receipts.uploadId, uploadIdNum));

    // Delete any processing errors for this upload
    await db.delete(processingErrors).where(eq(processingErrors.uploadId, uploadIdNum));

    // Delete the old marked image file (will be regenerated)
    if (upload.markedImageUrl) {
      await deleteFile(upload.markedImageUrl);
    }

    // Update the upload status to 'processing'
    await db
      .update(receiptUploads)
      .set({
        status: 'processing',
        markedImageUrl: null,
        hasReceipts: null,
        updatedAt: new Date(),
      })
      .where(eq(receiptUploads.id, uploadIdNum));

    // Add a new job to the queue for reprocessing.
    // Use a unique jobId per reprocess attempt — BullMQ silently rejects duplicates
    // if a job with the same jobId already exists (e.g. from the original upload).
    const jobData: ReceiptJobData = {
      uploadId: uploadIdNum,
      imagePath: imagePath,
    };
    await receiptProcessingQueue.add('process-receipt', jobData, {
      jobId: `upload-${uploadIdNum}-reprocess-${Date.now()}`,
    });

    // Respond to the user
    return reply.status(202).send({
      uploadId: uploadIdNum,
      message: 'Receipt reprocessing has been queued.',
      statusUrl: `/receipts/${uploadIdNum}`,
    });
  });

  // DELETE endpoint to remove an upload and all related data + files
  server.delete('/receipts/:uploadId', { preHandler: [authenticate] }, async (request, reply) => {
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

    // Get all receipts to clean up their files and related data
    const existingReceipts = await db
      .select()
      .from(receipts)
      .where(eq(receipts.uploadId, uploadIdNum));

    for (const receipt of existingReceipts) {
      await db.delete(lineItems).where(eq(lineItems.receiptId, receipt.id));
      await db.delete(duplicateMatches).where(
        or(
          eq(duplicateMatches.receiptId, receipt.id),
          eq(duplicateMatches.potentialDuplicateId, receipt.id)
        )
      );
      if (receipt.imageUrl) {
        await deleteFile(receipt.imageUrl);
      }
    }

    await db.delete(receipts).where(eq(receipts.uploadId, uploadIdNum));
    await db.delete(processingErrors).where(eq(processingErrors.uploadId, uploadIdNum));

    // Delete image files from disk
    if (upload.rawImageUrl) {
      await deleteFile(upload.rawImageUrl);
    }
    if (upload.originalImageUrl) {
      await deleteFile(upload.originalImageUrl);
    }
    if (upload.markedImageUrl) {
      await deleteFile(upload.markedImageUrl);
    }

    // Delete the upload record itself
    await db.delete(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));

    return reply.send({ message: 'Upload and all related data deleted.' });
  });

  // Test endpoint — no auth, development only
  server.post('/ocr/test', async (request, reply) => {
    const { preprocess } = request.query as { preprocess?: string };
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'File upload is required.' });
    }
    const imageBuffer = await data.toBuffer();
    const analysisService = new ReceiptAnalysisService();
    const result = await analysisService.extractTextDebug(imageBuffer, preprocess !== 'false');
    if (result.merged === null) {
      return reply.status(422).send({ error: 'OCR failed to extract text from the image.' });
    }
    return reply.send(result);
  });
}