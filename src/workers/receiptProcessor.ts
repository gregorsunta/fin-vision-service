import { Worker, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import { db } from '../db/index.js';
import { processingErrors, receipts, receiptUploads } from '../db/schema.js';
import { ReceiptJobData } from '../queue/index.js';
import { checkForDuplicates, markReceiptAsDuplicate } from '../services/duplicate-detector.js';
import { ImageSplitterService } from '../services/image-splitter.js';
import { ReceiptAnalysisService } from '../services/receipt-analysis.js';
import { compressToWebP, hashFilename, saveFile } from '../utils/file-utils.js';
import { getConfig } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import dotenv from 'dotenv';

import { correctOrientationOSD } from './stages/orientation.js';
import { extractRateLimitError, isRateLimitError } from './stages/errors.js';
import { resolveImagePath } from './stages/path.js';
import { persistMarkedImage } from './stages/marked-image.js';
import { deriveReceiptCategory, saveExtractedData } from './stages/save-extracted.js';
import { processSingleReceipt } from './stages/single-receipt.js';

dotenv.config();

const log = createLogger('worker.receiptProcessor');

const connection = {
  host: getConfig().REDIS_HOST,
  port: getConfig().REDIS_PORT,
};

const receiptProcessorWorker = new Worker<ReceiptJobData>(
  'receipt-processing',
  async (job) => {
    const { uploadId, imagePath, receiptId, receiptImagePath } = job.data;

    // Single-receipt reprocess path (resume, user retry)
    if (receiptId && receiptImagePath) {
      log.info({ jobId: job.id, uploadId, receiptId }, 'processing single receipt job');
      await processSingleReceipt(job, uploadId, receiptId, receiptImagePath);
      return;
    }

    log.info({ jobId: job.id, uploadId }, 'processing upload job');

    const [uploadJob] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadId));
    if (!uploadJob) {
      throw new Error(`Upload job ${uploadId} not found.`);
    }

    if (uploadJob.status === 'duplicate') {
      log.info({ jobId: job.id, uploadId }, 'upload is a duplicate, skipping processing');
      return;
    }

    try {
      const fullImagePath = resolveImagePath(imagePath);
      log.info({ jobId: job.id, uploadId, fullImagePath }, 'reading image');
      // Image is already EXIF-normalized and metadata-stripped by compressToWebP() at upload time.
      const imageBuffer = await fs.readFile(fullImagePath);

      // 1. Split the image
      await job.updateProgress(5);
      log.info({ jobId: job.id, uploadId }, 'splitting image');
      const imageSplitter = new ImageSplitterService();
      const splitResult = await imageSplitter.splitImage(imageBuffer);

      if (splitResult.images.length === 0) {
        await db
          .update(receiptUploads)
          .set({ status: 'completed', hasReceipts: 0 })
          .where(eq(receiptUploads.id, uploadId));
        log.info({ jobId: job.id, uploadId }, 'processing complete, no receipts found');
        await job.updateProgress(100);
        return;
      }

      await db.update(receiptUploads).set({ hasReceipts: 1 }).where(eq(receiptUploads.id, uploadId));

      // 2. Save split metadata + marked image overlay
      await job.updateProgress(10);
      await persistMarkedImage(uploadId, imageBuffer, splitResult);

      // 3. Process each detected receipt
      log.info(
        { jobId: job.id, uploadId, receiptCount: splitResult.images.length },
        'found receipts, analyzing each',
      );
      const receiptAnalyzer = new ReceiptAnalysisService();
      let allSucceeded = true;
      let rateLimitedReached = false;
      const totalReceipts = splitResult.images.length;

      // Minimum milliseconds between receipts to avoid hitting provider RPM limits.
      // Each receipt can trigger up to 3 AI calls (analysis + JSON-parse retry +
      // price-mismatch retry). 12s is a reasonable middle ground for 15 RPM.
      // Set AI_RECEIPT_DELAY_MS=0 in .env to disable (e.g. on a paid Gemini tier).
      const receiptDelayMs = getConfig().AI_RECEIPT_DELAY_MS;

      for (let i = 0; i < totalReceipts; i++) {
        if (i > 0 && receiptDelayMs > 0) {
          log.debug({ jobId: job.id, uploadId, receiptDelayMs }, 'waiting before next receipt to respect RPM limits');
          await new Promise((resolve) => setTimeout(resolve, receiptDelayMs));
        }

        const receiptImageBuffer = splitResult.images[i];
        const progress = 15 + Math.round((i / totalReceipts) * 80);
        await job.updateProgress(progress);

        // Orient BEFORE saving — same buffer feeds both the saved file and OCR.
        const orientedBuffer = await correctOrientationOSD(receiptImageBuffer, i + 1);

        const compressedReceipt = await compressToWebP(orientedBuffer);
        const { publicUrl: receiptImageUrl } = await saveFile(
          compressedReceipt,
          hashFilename(compressedReceipt, '.webp'),
        );

        let receiptRecordId!: number;
        await db.transaction(async (tx) => {
          const rows = await tx
            .select({ num: receipts.userReceiptNumber })
            .from(receipts)
            .innerJoin(receiptUploads, eq(receipts.uploadId, receiptUploads.id))
            .where(eq(receiptUploads.userId, uploadJob.userId))
            .for('update');
          const userReceiptNumber = rows.reduce((m, r) => Math.max(m, r.num), 0) + 1;
          const result = await tx.insert(receipts).values({
            uploadId,
            userReceiptNumber,
            status: 'pending',
            imageUrl: receiptImageUrl,
          });
          receiptRecordId = result[0].insertId;
        });

        // If a previous receipt in this batch hit rate limit, skip the AI call —
        // the quota isn't going to recover mid-batch.
        if (rateLimitedReached) {
          await db.update(receipts).set({ status: 'rate_limited' }).where(eq(receipts.id, receiptRecordId));
          await db.insert(processingErrors).values({
            uploadId,
            receiptId: receiptRecordId,
            category: 'SYSTEM_ERROR',
            message: 'Skipped: previous receipt in this batch hit AI rate limit.',
            metadata: { errorType: 'RATE_LIMITED', skipped: true },
          });
          allSucceeded = false;
          continue;
        }

        try {
          const analysisResult = await receiptAnalyzer.analyzeReceipts([orientedBuffer]);
          const extractedData = analysisResult[0];

          if (!extractedData || !extractedData.total) {
            throw new Error('Invalid or empty data returned from analysis.');
          }

          const receiptCategory = deriveReceiptCategory(extractedData.items);
          await saveExtractedData(db, extractedData, receiptRecordId, uploadId, receiptCategory);

          log.info(
            { jobId: job.id, uploadId, receiptId: receiptRecordId, index: i + 1, total: totalReceipts },
            'receipt processed successfully, checking for duplicates',
          );
          const duplicateCheck = await checkForDuplicates(receiptRecordId, uploadJob.userId);

          if (duplicateCheck.isDuplicate && duplicateCheck.matchedReceipt) {
            await markReceiptAsDuplicate(
              receiptRecordId,
              duplicateCheck.matchedReceipt.id,
              duplicateCheck.confidenceScore,
            );
            log.info(
              { jobId: job.id, uploadId, receiptId: receiptRecordId, matchedReceiptId: duplicateCheck.matchedReceipt.id },
              'receipt marked as duplicate',
            );
          }
        } catch (err) {
          allSucceeded = false;
          const rateLimitErr = extractRateLimitError(err);
          const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred during analysis.';
          const errorStack = err instanceof Error ? err.stack : undefined;
          log.error({ err, jobId: job.id, uploadId, receiptId: receiptRecordId }, 'error processing receipt');

          if (rateLimitErr) {
            // Mark as 'rate_limited' (distinct from 'pending') and stop the batch.
            rateLimitedReached = true;
            await db.update(receipts).set({ status: 'rate_limited' }).where(eq(receipts.id, receiptRecordId));
            await db.insert(processingErrors).values({
              uploadId,
              receiptId: receiptRecordId,
              category: 'SYSTEM_ERROR',
              message: `AI rate limit hit: ${errorMessage}`,
              metadata: {
                errorType: 'RATE_LIMITED',
                provider: rateLimitErr.provider,
                resetTime: rateLimitErr.resetTime.toISOString(),
              },
            });
          } else {
            await db.update(receipts).set({ status: 'failed' }).where(eq(receipts.id, receiptRecordId));
            await db.insert(processingErrors).values({
              uploadId,
              receiptId: receiptRecordId,
              category: 'EXTRACTION_FAILURE',
              message: errorMessage,
              metadata: { stack: errorStack },
            });
          }
        }
      }

      // 4. Finalize
      const finalStatus = allSucceeded ? 'completed' : 'partly_completed';
      await db.update(receiptUploads).set({ status: finalStatus }).where(eq(receiptUploads.id, uploadId));
      await job.updateProgress(100);
      log.info({ jobId: job.id, uploadId, finalStatus }, 'processing finished');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const errorStack = err instanceof Error ? err.stack : undefined;
      log.error({ err, jobId: job.id, uploadId }, 'job failed critically');
      await db.update(receiptUploads).set({ status: 'failed' }).where(eq(receiptUploads.id, uploadId));
      await db.insert(processingErrors).values({
        uploadId,
        category: 'SYSTEM_ERROR',
        message: errorMessage,
        metadata: { stack: errorStack },
      });
      // Rate limit errors should NOT be retried — retries just waste more quota.
      if (isRateLimitError(err)) {
        throw new UnrecoverableError(`Rate limit hit: ${errorMessage}`);
      }
      throw err;
    }
  },
  { connection },
);

receiptProcessorWorker.on('completed', (job) => {
  log.info({ jobId: job.id }, 'job has completed');
});

receiptProcessorWorker.on('failed', (job, err) => {
  log.error({ err, jobId: job?.id }, 'job has failed');
});

export default receiptProcessorWorker;
