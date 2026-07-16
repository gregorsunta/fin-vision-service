import { and, eq, isNull, lte } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { bankStatementUploads, processingErrors } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('services.bank-statement.review-ttl');

/**
 * Sweeps any pending_user_review uploads whose pendingReviewExpiresAt has
 * passed: marks them as failed and clears the redacted text.
 *
 * The redacted text is sensitive (it would be sent to the AI on confirm), so
 * we deliberately don't keep it around indefinitely if the user has not acted
 * on it.
 *
 * Wired up from the API bootstrap with a setInterval, similar to the receipt
 * auto-resume scheduler.
 */
export async function expirePendingReviews(): Promise<{ expired: number }> {
  const now = new Date();
  const candidates = await db
    .select()
    .from(bankStatementUploads)
    .where(and(
      eq(bankStatementUploads.status, 'pending_user_review'),
      isNull(bankStatementUploads.deletedAt),
      lte(bankStatementUploads.pendingReviewExpiresAt, now),
    ));

  if (!candidates.length) return { expired: 0 };

  for (const upload of candidates) {
    await db.update(bankStatementUploads)
      .set({
        status: 'failed',
        redactedText: null,
        pendingReviewExpiresAt: null,
      })
      .where(eq(bankStatementUploads.id, upload.id));
    await db.insert(processingErrors).values({
      uploadType: 'bank_statement',
      uploadId: upload.id,
      category: 'SYSTEM_ERROR',
      message: 'Review TTL expired without user confirmation; redacted text discarded.',
      metadata: { errorType: 'REVIEW_TTL_EXPIRED' },
    });
    log.info({ uploadId: upload.id, userId: upload.userId }, 'review expired, redacted text cleared');
  }

  return { expired: candidates.length };
}
