import { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import { ImageSplitterService } from '../../services/image-splitter.js';
import { ReceiptAnalysisService } from '../../services/receipt-analysis.js';
import { db } from '../../db/index.js';
import { receiptUploads, receipts, lineItems, processingErrors } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, '../../../uploads');

// Ensure the uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

async function saveFile(buffer: Buffer, originalFilename: string): Promise<{ filePath: string, publicUrl: string }> {
  const uniqueSuffix = randomBytes(16).toString('hex');
  const extension = path.extname(originalFilename) || '.jpg';
  const uniqueFilename = `${uniqueSuffix}${extension}`;
  const filePath = path.join(UPLOADS_DIR, uniqueFilename);
  await fs.promises.writeFile(filePath, buffer);
  const publicUrl = `/files/${uniqueFilename}`;
  return { filePath, publicUrl };
}

export default async function imageProcessingRoutes(server: FastifyInstance) {
  // This endpoint is now a legacy endpoint, the main logic is in /split-and-analyze
  server.post('/image/split', { preHandler: [authenticate] }, async (_request, reply) => {
    return reply.status(400).send({
      error: 'This endpoint is deprecated. Please use /api/image/split-and-analyze for full processing.',
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
    const { publicUrl: originalImageUrl } = await saveFile(imageBuffer, data.filename);

    // 1. Create the master upload job
    const insertResult = await db.insert(receiptUploads).values({
      userId: request.user.id,
      originalImageUrl,
      updatedAt: new Date(),
    });
    const uploadJobId = insertResult[0].insertId;
    const [uploadJob] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadJobId));

    try {
      // 2. Split the image
      const imageSplitter = new ImageSplitterService();
      const splitResult = await imageSplitter.splitImage(imageBuffer, { debug: true });

      if (splitResult.images.length === 0) {
        await db.update(receiptUploads).set({ status: 'completed', hasReceipts: 0 }).where(eq(receiptUploads.id, uploadJob.id));
        return reply.send({
          uploadId: uploadJob.id,
          message: 'Processing complete. No receipts were found in the image.',
          originalImageUrl,
          successful_receipts: [],
          failed_receipts: [],
        });
      }
      
      await db.update(receiptUploads).set({ hasReceipts: 1 }).where(eq(receiptUploads.id, uploadJob.id));

      // 3. Create Marked Image
      let markedImageBuffer = imageBuffer;
      if (splitResult.debug?.boundingBoxes) {
          const { width, height } = await sharp(imageBuffer).metadata();
          const rects = splitResult.debug.boundingBoxes.map(box => {
              // Convert 1000-grid to pixel coords
              const left = Math.round((box.x / 1000) * width!);
              const top = Math.round((box.y / 1000) * height!);
              const rectWidth = Math.round((box.width / 1000) * width!);
              const rectHeight = Math.round((box.height / 1000) * height!);
              return `<rect x="${left}" y="${top}" width="${rectWidth}" height="${rectHeight}" stroke="red" stroke-width="5" fill="none"/>`;
          });
          const svgOverlay = `<svg width="${width}" height="${height}">${rects.join('')}</svg>`;
          markedImageBuffer = await sharp(imageBuffer).composite([{ input: Buffer.from(svgOverlay), blend: 'over' }]).toBuffer();
      }
      const { publicUrl: markedImageUrl } = await saveFile(markedImageBuffer, `marked-${data.filename}`);
      await db.update(receiptUploads).set({ markedImageUrl }).where(eq(receiptUploads.id, uploadJob.id));

      // 4. Process each receipt individually
      const receiptAnalyzer = new ReceiptAnalysisService();
      const successfulReceipts: any[] = [];
      const failedReceipts: any[] = [];
      let allSucceeded = true;

      for (let i = 0; i < splitResult.images.length; i++) {
        const receiptImageBuffer = splitResult.images[i];
        const { publicUrl: receiptImageUrl } = await saveFile(receiptImageBuffer, `receipt-${i}-${data.filename}`);

        // Create receipt record in DB
        const receiptInsertResult = await db.insert(receipts).values({
          uploadId: uploadJob.id,
          status: 'pending',
          imageUrl: receiptImageUrl,
        });
        const receiptRecordId = receiptInsertResult[0].insertId;

        try {
          // Call analysis service for this single receipt
          const analysisResult = await receiptAnalyzer.analyzeReceipts([receiptImageBuffer]);
          const extractedData = analysisResult[0]; // analyzeReceipts is now single-entry

          if (!extractedData || !extractedData.total) {
              throw new Error('Invalid or empty data returned from analysis.');
          }

          // Update receipt record with extracted data
          await db.update(receipts)
            .set({
              status: 'processed',
              storeName: extractedData.merchantName,
              totalAmount: extractedData.total.toString(),
              taxAmount: extractedData.tax?.toString(),
              transactionDate: new Date(extractedData.transactionDate),
              keywords: extractedData.keywords,
            })
            .where(eq(receipts.id, receiptRecordId));

          // Insert line items
          if (extractedData.items && extractedData.items.length > 0) {
            await db.insert(lineItems).values(
              extractedData.items.map(item => ({
                receiptId: receiptRecordId,
                description: item.description,
                quantity: item.quantity.toString(),
                unitPrice: item.price.toString(),
                keywords: item.keywords,
              }))
            );
          }
          successfulReceipts.push({ receiptId: receiptRecordId, imageUrl: receiptImageUrl, data: extractedData });
        } catch (err: any) {
          allSucceeded = false;
          const errorMessage = err.message || 'An unknown error occurred during analysis.';
          // Update DB
          await db.update(receipts).set({ status: 'failed' }).where(eq(receipts.id, receiptRecordId));
          await db.insert(processingErrors).values({
            uploadId: uploadJob.id,
            receiptId: receiptRecordId,
            category: 'EXTRACTION_FAILURE',
            message: errorMessage,
          });
          failedReceipts.push({ receiptId: receiptRecordId, imageUrl: receiptImageUrl, error: errorMessage });
        }
      }

      // 5. Finalize and Respond
      const finalStatus = allSucceeded ? 'completed' : 'partly_completed';
      await db.update(receiptUploads).set({ status: finalStatus }).where(eq(receiptUploads.id, uploadJob.id));
      
      reply.send({
          uploadId: uploadJob.id,
          message: `Processing complete. ${successfulReceipts.length} succeeded, ${failedReceipts.length} failed.`,
          originalImageUrl,
          markedImageUrl,
          successful_receipts: successfulReceipts,
          failed_receipts: failedReceipts
      });

    } catch (err: any) {
      await db.update(receiptUploads).set({ status: 'failed' }).where(eq(receiptUploads.id, uploadJob.id));
      await db.insert(processingErrors).values({
        uploadId: uploadJob.id,
        category: 'SYSTEM_ERROR',
        message: err.message,
      });
      console.error('Unhandled error in split-and-analyze:', err);
      return reply.status(500).send({ uploadId: uploadJob.id, error: 'A critical error occurred during processing.' });
    }
  });
}