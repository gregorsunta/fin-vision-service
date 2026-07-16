import { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import {
  bankAccounts,
  bankStatementUploads,
  bankTransactions,
  receiptEditHistory,
} from '../../../db/schema.js';
import { bankStatementProcessingQueue, bankStatementAiSendQueue, BankStatementJobData } from '../../../queue/index.js';
import { redactPII } from '../../../services/bank-statement/pii-filter.js';

// Fields the user can edit on a transaction row. Whitelist matches the GDPR
// schema: counterparty/reference fields no longer exist on bank_transactions.
// Edits produce receipt_edit_history entries — a corrected description becomes
// a labeled training sample (and stays PII-redacted).
const EDITABLE_TX_FIELDS = [
  'description',
  'debit',
  'credit',
  'category',
] as const;
type EditableTxField = typeof EDITABLE_TX_FIELDS[number];

export default async function bankStatementEditRoutes(server: FastifyInstance) {
  // Link / move a statement upload to a bank account — used when the upload
  // was created with status='needs_account_selection'.
  server.patch('/bank-statements/:uploadId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const uploadId = Number((request.params as { uploadId: string }).uploadId);
    if (isNaN(uploadId)) return reply.status(400).send({ error: 'Invalid uploadId' });

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
    if (!upload || upload.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    const body = request.body as { bankAccountId?: number; requeue?: boolean };
    if (body.bankAccountId == null) return reply.status(400).send({ error: 'bankAccountId is required' });

    const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, body.bankAccountId));
    if (!account || account.deletedAt) return reply.status(404).send({ error: 'Bank account not found' });
    if (account.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    await db.transaction(async (tx) => {
      await tx.update(bankStatementUploads)
        .set({
          bankAccountId: body.bankAccountId!,
          // If the upload was waiting for a selection, bounce it back to processing
          // so the requeued job can finish.
          status: upload.status === 'needs_account_selection' ? 'processing' : upload.status,
        })
        .where(eq(bankStatementUploads.id, uploadId));
      await tx.insert(receiptEditHistory).values({
        entityType: 'bank_statement_upload',
        entityId: uploadId,
        fieldName: 'bankAccountId',
        oldValue: upload.bankAccountId == null ? null : String(upload.bankAccountId),
        newValue: String(body.bankAccountId),
        changedBy: request.user!.id,
      });
    });

    if (upload.status === 'needs_account_selection' || body.requeue) {
      if (upload.redactedText) {
        // PDF that already passed Phase 1 + user review. Re-send to Phase 2
        // directly — userConfirmedAt is already set and redactedText is intact,
        // so there's no need to re-run extraction or ask for confirmation again.
        await bankStatementAiSendQueue.add('ai-send', { uploadId }, {
          jobId: `bank-statement-${uploadId}-ai-retry-${Date.now()}`,
        });
      } else {
        // CSV/XLSX or PDF that needs fresh Phase 1 extraction.
        const job: BankStatementJobData = {
          uploadId,
          filePath: upload.fileUrl.replace(/^\/files\//, 'uploads/'),
          mimeType: upload.mimeType,
          originalFileName: upload.originalFileName ?? undefined,
        };
        await bankStatementProcessingQueue.add('process-statement', job, { jobId: `bank-statement-${uploadId}-retry-${Date.now()}` });
      }
    }

    return reply.send({ ok: true });
  });

  // Edit a single transaction field. Matches receipt-editing.ts' pattern of
  // writing to receipt_edit_history for every field change.
  server.patch('/bank-statements/:uploadId/transactions/:txId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const { uploadId, txId } = request.params as { uploadId: string; txId: string };
    const uploadIdNum = Number(uploadId);
    const txIdNum = Number(txId);
    if (isNaN(uploadIdNum) || isNaN(txIdNum)) return reply.status(400).send({ error: 'Invalid ids' });

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadIdNum));
    if (!upload || upload.deletedAt) return reply.status(404).send({ error: 'Upload not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    const [tx] = await db.select().from(bankTransactions).where(and(
      eq(bankTransactions.id, txIdNum),
      eq(bankTransactions.statementUploadId, uploadIdNum),
    ));
    if (!tx || tx.deletedAt) return reply.status(404).send({ error: 'Transaction not found' });

    const body = request.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    const historyWrites: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

    for (const field of EDITABLE_TX_FIELDS) {
      if (!(field in body)) continue;
      const newValue = body[field];
      const currentValue = (tx as unknown as Record<string, unknown>)[field];
      if (newValue === currentValue) continue;

      if (field === 'debit' || field === 'credit') {
        if (newValue != null && typeof newValue !== 'number') {
          return reply.status(400).send({ error: `${field} must be a number` });
        }
        updates[field] = newValue == null ? null : (newValue as number).toFixed(4);
      } else if (field === 'description') {
        if (newValue != null && typeof newValue !== 'string') {
          return reply.status(400).send({ error: `${field} must be a string` });
        }
        // Re-run the redactor on user-supplied edits so a typed-in name or
        // email never lands in the DB even if the user pastes raw text.
        updates[field] = newValue == null ? null : redactPII(newValue as string).text;
      } else {
        if (newValue != null && typeof newValue !== 'string') {
          return reply.status(400).send({ error: `${field} must be a string` });
        }
        updates[field] = newValue ?? null;
      }

      historyWrites.push({
        field,
        oldValue: currentValue == null ? null : String(currentValue),
        newValue: newValue == null ? null : String(newValue),
      });
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ error: 'No editable fields in body' });
    }

    updates.editedAt = new Date();

    await db.transaction(async (trx) => {
      await trx.update(bankTransactions).set(updates).where(eq(bankTransactions.id, txIdNum));
      for (const h of historyWrites) {
        await trx.insert(receiptEditHistory).values({
          entityType: 'bank_transaction',
          entityId: txIdNum,
          fieldName: h.field,
          oldValue: h.oldValue,
          newValue: h.newValue,
          changedBy: request.user!.id,
        });
      }
    });

    return reply.send({ ok: true });
  });

  // Soft-delete the upload (and implicitly hide its transactions via the
  // join filter; transactions themselves aren't marked deletedAt to preserve
  // match history).
  server.delete('/bank-statements/:uploadId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const uploadId = Number((request.params as { uploadId: string }).uploadId);
    if (isNaN(uploadId)) return reply.status(400).send({ error: 'Invalid uploadId' });

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
    if (!upload || upload.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.update(bankStatementUploads).set({ deletedAt: now }).where(eq(bankStatementUploads.id, uploadId));
      await tx.update(bankTransactions).set({ deletedAt: now }).where(eq(bankTransactions.statementUploadId, uploadId));
    });

    return reply.send({ ok: true });
  });

  // Edit helper for allowed fields — useful during manual review
  server.get('/bank-statements/_allowed-transaction-fields', async () => ({ fields: EDITABLE_TX_FIELDS }));
}

export type { EditableTxField };
