import { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { authenticate } from '../auth.js';
import { receiptProcessingQueue, ReceiptJobData } from '../../queue/index.js';
import { db } from '../../db/index.js';
import { receiptUploads, receipts, lineItems, processingErrors, duplicateMatches } from '../../db/schema.js';
import { eq, and, or, sql } from 'drizzle-orm';
import { saveFile, compressToWebP, deleteFile, UPLOADS_DIR } from '../../utils/file-utils.js';
import { overrideDuplicateFlag } from '../../services/duplicate-detector.js';
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
          imageUrl: receipt.imageUrl,
          keywords: receipt.keywords,
          isDuplicate: receipt.isDuplicate,
          duplicateOfReceiptId: receipt.duplicateOfReceiptId,
          duplicateConfidenceScore: receipt.duplicateConfidenceScore,
          processingMetadata: receipt.processingMetadata,
          lineItems: items,
        };
      })
    );

    // Get any processing errors
    const errors = await db
      .select()
      .from(processingErrors)
      .where(eq(processingErrors.uploadId, uploadIdNum));

    // Calculate statistics
    const totalDetected = receiptsList.length;
    const successfulCount = receiptsList.filter(r => r.status === 'processed').length;
    const failedCount = receiptsList.filter(r => r.status === 'failed' || r.status === 'unreadable').length;
    const processingCount = receiptsList.filter(r => r.status === 'pending').length;
    const receiptIdsWithWarnings = new Set(
      errors.filter(e => e.category === 'VALIDATION_WARNING' && e.receiptId).map(e => e.receiptId)
    );
    const needsReviewCount = receiptIdsWithWarnings.size;

    // Separate receipts into successful and failed
    const successfulReceipts = receiptsWithItems.filter(r => r.status === 'processed');
    const failedReceipts = receiptsWithItems.filter(r => r.status === 'failed' || r.status === 'unreadable');
    const processingReceipts = receiptsWithItems.filter(r => r.status === 'pending');

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
        failed: failedReceipts,
        processing: processingReceipts,
        all: receiptsWithItems, // All receipts in one array for convenience
      },

      // Processing errors
      errors: errors,
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
      imageUrl: receipt.imageUrl,
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

    const compressedBuffer = await compressToWebP(imageBuffer);
    const { filePath, publicUrl: originalImageUrl } = await saveFile(compressedBuffer, 'upload.webp');

    // Get next upload number for this user
    const [{ maxNum }] = await db
      .select({ maxNum: sql<number>`COALESCE(MAX(${receiptUploads.uploadNumber}), 0)` })
      .from(receiptUploads)
      .where(eq(receiptUploads.userId, request.user.id));
    const uploadNumber = maxNum + 1;

    if (existingUpload) {
      // Duplicate upload detected — save record but skip processing
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

    // 1. Create the master upload job record
    const insertResult = await db.insert(receiptUploads).values({
        userId: request.user.id,
        uploadNumber,
        originalImageUrl,
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

    // Reset receipt status to pending
    await db
      .update(receipts)
      .set({
        status: 'pending',
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
      jobId: `receipt-${receiptIdNum}`,
    });

    return reply.status(202).send({
      uploadId: uploadIdNum,
      receiptId: receiptIdNum,
      message: 'Single receipt reprocessing has been queued.',
      statusUrl: `/receipts/${uploadIdNum}/receipt/${receiptIdNum}`,
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

    // Delete existing receipts and line items for this upload
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
    }

    // Delete all receipts for this upload
    await db.delete(receipts).where(eq(receipts.uploadId, uploadIdNum));

    // Delete any processing errors for this upload
    await db.delete(processingErrors).where(eq(processingErrors.uploadId, uploadIdNum));

    // Update the upload status to 'processing'
    await db
      .update(receiptUploads)
      .set({
        status: 'processing',
        markedImageUrl: null, // Clear the marked image URL
        hasReceipts: null, // Reset receipt detection flag
        updatedAt: new Date(),
      })
      .where(eq(receiptUploads.id, uploadIdNum));

    // Add a new job to the queue for reprocessing
    const jobData: ReceiptJobData = {
      uploadId: uploadIdNum,
      imagePath: imagePath,
    };
    await receiptProcessingQueue.add('process-receipt', jobData, {
      jobId: `upload-${uploadIdNum}`,
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
}