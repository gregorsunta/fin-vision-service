import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import { bankStatementUploads, receiptEditHistory } from '../../../db/schema.js';
import {
  bankStatementAiSendQueue,
  type BankStatementAiSendJobData,
} from '../../../queue/index.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('routes.bank-statements.review');

/**
 * GDPR review-gate endpoints. Phase 1 of the worker pipeline saves the
 * redacted statement text under `pending_user_review`. The user must hit
 * the confirm endpoint here before the AI call (Phase 2) is enqueued.
 *
 *  - GET    /bank-statements/:id/preview        → see what would be sent
 *  - POST   /bank-statements/:id/confirm-send   → explicit user confirm
 *  - POST   /bank-statements/:id/cancel-pending-review → drop the upload
 */
export default async function bankStatementReviewRoutes(server: FastifyInstance) {
  server.get('/bank-statements/:uploadId/preview', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const uploadId = Number((request.params as { uploadId: string }).uploadId);
    if (isNaN(uploadId)) return reply.status(400).send({ error: 'Invalid uploadId' });

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
    if (!upload || upload.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    return reply.send({
      uploadId: upload.id,
      status: upload.status,
      redactedText: upload.redactedText,
      redactionStats: upload.redactionStats,
      detectedIban: upload.detectedIban,
      pendingReviewExpiresAt: upload.pendingReviewExpiresAt,
      userConfirmedAt: upload.userConfirmedAt,
    });
  });

  server.post('/bank-statements/:uploadId/confirm-send', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const uploadId = Number((request.params as { uploadId: string }).uploadId);
    if (isNaN(uploadId)) return reply.status(400).send({ error: 'Invalid uploadId' });

    const body = (request.body ?? {}) as { acknowledged?: boolean };
    // The frontend must explicitly set acknowledged=true after the user ticks
    // a confirmation checkbox in the modal. Accidental POSTs without the flag
    // are rejected. See fin-vision-app BankStatementReviewPage.svelte.
    if (body.acknowledged !== true) {
      return reply.status(400).send({
        error: 'Missing acknowledgement',
        detail: 'POST body must include { acknowledged: true } — the user must explicitly confirm.',
      });
    }

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
    if (!upload || upload.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    if (upload.status !== 'pending_user_review') {
      return reply.status(409).send({
        error: 'Wrong state',
        detail: `Upload is in '${upload.status}', not 'pending_user_review' — cannot confirm.`,
      });
    }
    if (!upload.redactedText) {
      return reply.status(409).send({
        error: 'No redacted text',
        detail: 'Redacted text was not captured for this upload — cannot send.',
      });
    }

    // Capture client IP for audit. Fastify exposes the resolved client IP
    // (respecting trust proxy settings) on request.ip.
    const fromIp = request.ip ?? null;
    const confirmedAt = new Date();

    await db.transaction(async (tx) => {
      await tx.update(bankStatementUploads)
        .set({
          status: 'processing',
          userConfirmedAt: confirmedAt,
          userConfirmedFromIp: fromIp,
        })
        .where(eq(bankStatementUploads.id, uploadId));

      // Audit row: the AI call is traceable to this exact user action.
      await tx.insert(receiptEditHistory).values({
        entityType: 'bank_statement_upload',
        entityId: uploadId,
        fieldName: 'userConfirmedAt',
        oldValue: null,
        newValue: confirmedAt.toISOString(),
        changedBy: request.user!.id,
      });
    });

    const job: BankStatementAiSendJobData = { uploadId };
    await bankStatementAiSendQueue.add('ai-send', job, {
      jobId: `bank-statement-ai-${uploadId}-${Date.now()}`,
    });
    log.info({ uploadId, userId: request.user.id, fromIp }, 'phase 2 enqueued after explicit user confirmation');

    return reply.send({ ok: true, status: 'processing' });
  });

  server.post('/bank-statements/:uploadId/cancel-pending-review', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const uploadId = Number((request.params as { uploadId: string }).uploadId);
    if (isNaN(uploadId)) return reply.status(400).send({ error: 'Invalid uploadId' });

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
    if (!upload || upload.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    if (upload.status !== 'pending_user_review') {
      return reply.status(409).send({
        error: 'Wrong state',
        detail: `Upload is in '${upload.status}', not 'pending_user_review' — cannot cancel review.`,
      });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(bankStatementUploads)
        .set({
          status: 'failed',
          redactedText: null,
          pendingReviewExpiresAt: null,
          deletedAt: now,
        })
        .where(eq(bankStatementUploads.id, uploadId));
      await tx.insert(receiptEditHistory).values({
        entityType: 'bank_statement_upload',
        entityId: uploadId,
        fieldName: 'reviewCancelled',
        oldValue: 'pending_user_review',
        newValue: 'cancelled_by_user',
        changedBy: request.user!.id,
      });
    });
    log.info({ uploadId, userId: request.user.id }, 'review cancelled by user');
    return reply.send({ ok: true });
  });
}
