import { eq, inArray } from 'drizzle-orm';
import path from 'path';
import { db } from '../db/index.js';
import { receiptUploads, receipts, processingErrors, users } from '../db/schema.js';
import { receiptProcessingQueue, ReceiptJobData } from '../queue/index.js';
import { UPLOADS_DIR } from '../utils/file-utils.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('services.resumeProcessing');

/**
 * Resumes all rate-limited receipts for a given upload.
 * Re-queues each as an individual single-receipt job with staggered delays.
 * Returns the count of receipts queued, or 0 if nothing was eligible.
 */
export async function resumeRateLimitedReceipts(uploadId: number): Promise<number> {
  const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadId));
  if (!upload) return 0;

  const errorsForUpload = await db
    .select()
    .from(processingErrors)
    .where(eq(processingErrors.uploadId, uploadId));

  const rateLimitedReceiptIds = new Set(
    errorsForUpload
      .filter((e) => {
        const meta = e.metadata as { errorType?: string } | null;
        return meta?.errorType === 'RATE_LIMITED' && e.receiptId !== null;
      })
      .map((e) => e.receiptId as number)
  );

  if (rateLimitedReceiptIds.size === 0) return 0;

  const allReceiptsForUpload = await db
    .select()
    .from(receipts)
    .where(eq(receipts.uploadId, uploadId));

  const toResume = allReceiptsForUpload.filter(
    (r) => rateLimitedReceiptIds.has(r.id) && r.status === 'rate_limited'
  );

  if (toResume.length === 0) return 0;

  for (const receipt of toResume) {
    await db.update(receipts).set({ status: 'pending' }).where(eq(receipts.id, receipt.id));
  }

  for (const error of errorsForUpload) {
    const meta = error.metadata as { errorType?: string } | null;
    if (meta?.errorType === 'RATE_LIMITED' && error.receiptId && rateLimitedReceiptIds.has(error.receiptId)) {
      await db.delete(processingErrors).where(eq(processingErrors.id, error.id));
    }
  }

  const receiptDelayMs = parseInt(process.env.AI_RECEIPT_DELAY_MS || '12000', 10);
  const uploadFilename = path.basename(upload.originalImageUrl);
  for (let idx = 0; idx < toResume.length; idx++) {
    const receipt = toResume[idx];
    const receiptFilename = receipt.imageUrl ? path.basename(receipt.imageUrl) : '';
    const jobData: ReceiptJobData = {
      uploadId,
      imagePath: path.join(UPLOADS_DIR, uploadFilename),
      receiptId: receipt.id,
      receiptImagePath: receiptFilename ? path.join(UPLOADS_DIR, receiptFilename) : '',
    };
    await receiptProcessingQueue.add('process-single-receipt', jobData, {
      jobId: `receipt-${receipt.id}-resume-${Date.now()}`,
      delay: idx * receiptDelayMs,
    });
  }

  await db
    .update(receiptUploads)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(receiptUploads.id, uploadId));

  return toResume.length;
}

/**
 * Checks all users with autoResumeRateLimited=true and re-queues uploads
 * whose rate-limit resetTime has passed. Called by the scheduler in api/index.ts.
 */
export async function autoResumeEligibleUploads(): Promise<void> {
  const now = new Date();

  // Find all partly_completed uploads that have rate-limited receipts
  const rateLimitErrors = await db
    .select()
    .from(processingErrors);

  // Group by uploadId, find latest resetTime per upload
  const uploadResetTimes = new Map<number, Date>();
  for (const error of rateLimitErrors) {
    const meta = error.metadata as { errorType?: string; resetTime?: string } | null;
    if (meta?.errorType !== 'RATE_LIMITED' || !meta.resetTime) continue;
    const resetTime = new Date(meta.resetTime);
    const existing = uploadResetTimes.get(error.uploadId);
    if (!existing || resetTime > existing) {
      uploadResetTimes.set(error.uploadId, resetTime);
    }
  }

  if (uploadResetTimes.size === 0) return;

  // Find eligible upload IDs where resetTime has passed
  const eligibleUploadIds = [...uploadResetTimes.entries()]
    .filter(([, resetTime]) => resetTime <= now)
    .map(([uploadId]) => uploadId);

  if (eligibleUploadIds.length === 0) return;

  // Check which of those uploads belong to users with autoResumeRateLimited=true
  const uploadsToCheck = await db
    .select({ id: receiptUploads.id, userId: receiptUploads.userId })
    .from(receiptUploads)
    .where(inArray(receiptUploads.id, eligibleUploadIds));

  if (uploadsToCheck.length === 0) return;

  const userIds = [...new Set(uploadsToCheck.map((u) => u.userId))];
  const eligibleUsers = await db
    .select({ id: users.id, autoResumeRateLimited: users.autoResumeRateLimited })
    .from(users)
    .where(inArray(users.id, userIds));

  const autoResumeUserIds = new Set(
    eligibleUsers.filter((u) => u.autoResumeRateLimited).map((u) => u.id)
  );

  if (autoResumeUserIds.size === 0) return;

  for (const upload of uploadsToCheck) {
    if (!autoResumeUserIds.has(upload.userId)) continue;
    const resumed = await resumeRateLimitedReceipts(upload.id);
    if (resumed > 0) {
      log.info({ uploadId: upload.id, resumed }, 'auto-resumed rate-limited receipts');
    }
  }
}
