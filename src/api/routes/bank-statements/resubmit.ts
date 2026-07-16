import path from 'path';
import { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';

import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import { bankStatementUploads, bankTransactions, processingErrors } from '../../../db/schema.js';
import { bankStatementProcessingQueue, type BankStatementJobData } from '../../../queue/index.js';
import { UPLOADS_DIR } from '../../../utils/file-utils.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('routes.bank-statements.resubmit');

const RESUBMITTABLE_STATUSES = new Set([
  'failed',
  'needs_account_selection',
  'pending_user_review',
]);

export default async function bankStatementResubmitRoutes(server: FastifyInstance) {
  /**
   * POST /bank-statements/:uploadId/resubmit
   *
   * Deletes all processing results for the upload (transactions, errors) and
   * re-enqueues Phase 1 from the original file on disk. The file itself is
   * never deleted. Allowed only when status is failed / needs_account_selection
   * / pending_user_review.
   */
  server.post('/bank-statements/:uploadId/resubmit', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const uploadId = Number((request.params as { uploadId: string }).uploadId);
    if (isNaN(uploadId)) return reply.status(400).send({ error: 'Invalid uploadId' });

    const [upload] = await db
      .select()
      .from(bankStatementUploads)
      .where(and(eq(bankStatementUploads.id, uploadId), isNull(bankStatementUploads.deletedAt)));

    if (!upload) return reply.status(404).send({ error: 'Upload not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    if (!RESUBMITTABLE_STATUSES.has(upload.status)) {
      return reply.status(409).send({
        error: `Upload cannot be resubmitted in status '${upload.status}'. Allowed: ${[...RESUBMITTABLE_STATUSES].join(', ')}.`,
      });
    }

    const filename = upload.fileUrl.replace('/files/', '');
    const filePath = path.join(UPLOADS_DIR, filename);

    log.info({ uploadId, status: upload.status, filePath }, 'resubmitting bank statement');

    await db.transaction(async (tx) => {
      // Remove previous processing output.
      await tx.delete(bankTransactions).where(eq(bankTransactions.statementUploadId, uploadId));
      await tx
        .delete(processingErrors)
        .where(and(eq(processingErrors.uploadType, 'bank_statement'), eq(processingErrors.uploadId, uploadId)));

      // Reset all processing state — keep file, userId, uploadNumber, mimeType.
      // Preserve bankAccountId if it was manually assigned: the user already
      // told us which account this belongs to, so Phase 1 can skip account
      // selection and go straight to pending_user_review → Phase 2.
      await tx
        .update(bankStatementUploads)
        .set({
          status: 'processing',
          parsingMetadata: null,
          redactedText: null,
          redactionStats: null,
          detectedIban: null,
          userConfirmedAt: null,
          userConfirmedFromIp: null,
          periodStart: null,
          periodEnd: null,
          openingBalance: null,
          closingBalance: null,
          totalDebit: null,
          totalCredit: null,
        })
        .where(eq(bankStatementUploads.id, uploadId));
    });

    // Unique jobId prevents BullMQ dedup from blocking the re-enqueue.
    const job: BankStatementJobData = {
      uploadId,
      filePath,
      mimeType: upload.mimeType,
      originalFileName: upload.originalFileName ?? undefined,
    };
    await bankStatementProcessingQueue.add('process-statement', job, {
      jobId: `bank-statement-${uploadId}-resubmit-${Date.now()}`,
    });

    return reply.status(202).send({
      uploadId,
      status: 'processing',
      statusUrl: `/api/bank-statements/${uploadId}`,
    });
  });
}
