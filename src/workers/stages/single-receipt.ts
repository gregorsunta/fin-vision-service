import fs from 'fs/promises';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { db } from '../../db/index.js';
import { processingErrors, receipts, receiptUploads } from '../../db/schema.js';
import { checkForDuplicates, markReceiptAsDuplicate } from '../../services/duplicate-detector.js';
import { ReceiptAnalysisService } from '../../services/receipt-analysis.js';
import { createLogger } from '../../utils/logger.js';
import { deriveReceiptCategory, saveExtractedData } from './save-extracted.js';
import { extractRateLimitError } from './errors.js';
import { resolveImagePath } from './path.js';

const log = createLogger('worker.stages.single-receipt');

/**
 * Reprocess path for a single receipt (e.g. "Resume rate-limited" or user
 * retry). Does NOT run splitting — the receipt already has its own cropped
 * image. On success, persists extraction + runs duplicate detection. On
 * failure, classifies rate-limit vs. extraction errors into the appropriate
 * status + processing_errors entry.
 *
 * After the per-receipt work, recalculates upload status because this path
 * targets a single receipt inside a potentially partially-completed upload.
 */
export async function processSingleReceipt(
  job: Job,
  uploadId: number,
  receiptId: number,
  receiptImagePath: string,
): Promise<void> {
  const [uploadJob] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadId));
  if (!uploadJob) {
    throw new Error(`Upload job ${uploadId} not found.`);
  }

  try {
    const fullPath = resolveImagePath(receiptImagePath);

    log.info({ jobId: job.id, uploadId, receiptId, fullPath }, 'reading receipt image');
    const receiptImageBuffer = await fs.readFile(fullPath);
    await job.updateProgress(10);

    const receiptAnalyzer = new ReceiptAnalysisService();

    try {
      const analysisResult = await receiptAnalyzer.analyzeReceipts([receiptImageBuffer]);
      const extractedData = analysisResult[0];

      if (!extractedData) {
        throw new Error('Invalid or empty data returned from analysis.');
      }

      if (extractedData.notAReceipt) {
        log.info(
          { jobId: job.id, uploadId, receiptId },
          'receipt identified as non-receipt image, marking unreadable',
        );
        await db.update(receipts).set({ status: 'unreadable' }).where(eq(receipts.id, receiptId));
        await db.insert(processingErrors).values({
          uploadId,
          receiptId,
          category: 'EXTRACTION_FAILURE',
          message: 'Image does not appear to be a receipt.',
          metadata: { errorType: 'NOT_A_RECEIPT' },
        });
        return;
      }

      if (!extractedData.total) {
        throw new Error('Invalid or empty data returned from analysis.');
      }

      const receiptCategory = deriveReceiptCategory(extractedData.items);
      await saveExtractedData(db, extractedData, receiptId, uploadId, receiptCategory);

      log.info(
        { jobId: job.id, uploadId, receiptId },
        'single receipt processed successfully, checking for duplicates',
      );
      const duplicateCheck = await checkForDuplicates(receiptId, uploadJob.userId);
      if (duplicateCheck.isDuplicate && duplicateCheck.matchedReceipt) {
        await markReceiptAsDuplicate(
          receiptId,
          duplicateCheck.matchedReceipt.id,
          duplicateCheck.confidenceScore,
        );
      }
    } catch (err) {
      log.error({ err, jobId: job.id, uploadId, receiptId }, 'error processing single receipt');
      const rateLimitErr = extractRateLimitError(err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      const errorStack = err instanceof Error ? err.stack : undefined;

      if (rateLimitErr) {
        await db.update(receipts).set({ status: 'rate_limited' }).where(eq(receipts.id, receiptId));
        await db.insert(processingErrors).values({
          uploadId,
          receiptId,
          category: 'SYSTEM_ERROR',
          message: `AI rate limit hit on resume: ${errorMessage}`,
          metadata: {
            errorType: 'RATE_LIMITED',
            provider: rateLimitErr.provider,
            resetTime: rateLimitErr.resetTime.toISOString(),
          },
        });
      } else {
        await db.update(receipts).set({ status: 'failed' }).where(eq(receipts.id, receiptId));
        await db.insert(processingErrors).values({
          uploadId,
          receiptId,
          category: 'EXTRACTION_FAILURE',
          message: errorMessage || 'An unknown error occurred during analysis.',
          metadata: { stack: errorStack },
        });
      }
    }

    // Recalculate upload status. 'rate_limited' receipts are NOT actively
    // being processed — they wait for the user to click resume — so they
    // count toward `partly_completed` rather than keeping the upload in
    // 'processing' (which would show as "Analyzing" in the UI).
    const allReceipts = await db.select().from(receipts).where(eq(receipts.uploadId, uploadId));
    const allProcessed = allReceipts.every((r) => r.status === 'processed');
    const allFailedOrLimited = allReceipts.every(
      (r) => r.status === 'failed' || r.status === 'unreadable' || r.status === 'rate_limited',
    );
    const allFailed = allReceipts.every((r) => r.status === 'failed' || r.status === 'unreadable');

    let finalStatus: 'completed' | 'partly_completed' | 'failed';
    if (allProcessed) {
      finalStatus = 'completed';
    } else if (allFailed) {
      finalStatus = 'failed';
    } else if (allFailedOrLimited) {
      finalStatus = 'partly_completed';
    } else {
      finalStatus = 'partly_completed';
    }

    await db.update(receiptUploads).set({ status: finalStatus }).where(eq(receiptUploads.id, uploadId));
    await job.updateProgress(100);
    log.info({ jobId: job.id, uploadId, receiptId, finalStatus }, 'single receipt reprocessing finished');
  } catch (err) {
    log.error({ err, jobId: job.id, uploadId, receiptId }, 'single receipt job failed critically');
    await db.update(receipts).set({ status: 'failed' }).where(eq(receipts.id, receiptId));

    const allReceipts = await db.select().from(receipts).where(eq(receipts.uploadId, uploadId));
    const allFailed = allReceipts.every((r) => r.status === 'failed' || r.status === 'unreadable');
    await db
      .update(receiptUploads)
      .set({ status: allFailed ? 'failed' : 'partly_completed' })
      .where(eq(receiptUploads.id, uploadId));

    throw err;
  }
}
