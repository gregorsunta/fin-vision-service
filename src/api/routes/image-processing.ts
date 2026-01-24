import { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import { receiptProcessingQueue, ReceiptJobData } from '../../queue/index.js';
import { db } from '../../db/index.js';
import { receiptUploads, receipts, lineItems, processingErrors } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { saveFile } from '../../utils/file-utils.js';

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

    // Separate receipts into successful and failed
    const successfulReceipts = receiptsWithItems.filter(r => r.status === 'processed');
    const failedReceipts = receiptsWithItems.filter(r => r.status === 'failed' || r.status === 'unreadable');
    const processingReceipts = receiptsWithItems.filter(r => r.status === 'pending');

    // Get all split receipt image URLs
    const splitReceiptImages = receiptsList.map(r => r.imageUrl).filter(url => url !== null);

    // Build comprehensive response
    return reply.send({
      uploadId: upload.id,
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
      },

      // Status message
      message: upload.status === 'processing' 
        ? `Processing in progress. ${processingCount} receipts still being processed.`
        : upload.status === 'completed'
        ? `Processing complete. ${successfulCount} succeeded, ${failedCount} failed.`
        : upload.status === 'partly_completed'
        ? `Processing partly completed. ${successfulCount} succeeded, ${failedCount} failed, ${processingCount} still processing.`
        : upload.status === 'failed'
        ? 'Processing failed.'
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
    const { filePath, publicUrl: originalImageUrl } = await saveFile(imageBuffer, data.filename);

    // 1. Create the master upload job record
    const insertResult = await db.insert(receiptUploads).values({
        userId: request.user.id,
        originalImageUrl,
        status: 'processing', // Set status to indicate work is queued
        updatedAt: new Date()
    });
    const uploadId = insertResult[0].insertId;

    // 2. Add a job to the queue for background processing
    const jobData: ReceiptJobData = {
        uploadId,
        imagePath: filePath,
    };
    await receiptProcessingQueue.add('process-receipt', jobData);

    // 3. Respond to the user immediately
    return reply.status(202).send({
        uploadId,
        message: 'Upload successful. Receipt processing has been queued.',
        statusUrl: `/receipts/${uploadId}`,
    });
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

    // Extract the file path from the original image URL
    // Assuming the URL format is like: /uploads/filename.jpg
    const imagePath = upload.originalImageUrl.replace(/^\//, ''); // Remove leading slash if present

    // Delete existing receipts and line items for this upload
    const existingReceipts = await db
      .select()
      .from(receipts)
      .where(eq(receipts.uploadId, uploadIdNum));

    for (const receipt of existingReceipts) {
      // Delete line items for each receipt
      await db.delete(lineItems).where(eq(lineItems.receiptId, receipt.id));
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
    await receiptProcessingQueue.add('process-receipt', jobData);

    // Respond to the user
    return reply.status(202).send({
      uploadId: uploadIdNum,
      message: 'Receipt reprocessing has been queued.',
      statusUrl: `/receipts/${uploadIdNum}`,
    });
  });
}