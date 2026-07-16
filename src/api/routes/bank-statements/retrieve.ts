import { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import {
  bankAccounts,
  bankStatementUploads,
  bankTransactions,
  processingErrors,
  transactionReceiptMatches,
} from '../../../db/schema.js';

export default async function bankStatementRetrieveRoutes(server: FastifyInstance) {
  // List uploads for the current user, optionally filtered by bankAccountId
  server.get('/bank-statements', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const query = request.query as { bankAccountId?: string; status?: string };
    const filters = [eq(bankStatementUploads.userId, request.user.id), isNull(bankStatementUploads.deletedAt)];
    if (query.bankAccountId) {
      const id = Number(query.bankAccountId);
      if (!isNaN(id)) filters.push(eq(bankStatementUploads.bankAccountId, id));
    }

    const uploads = await db
      .select({
        id: bankStatementUploads.id,
        uploadNumber: bankStatementUploads.uploadNumber,
        bankAccountId: bankStatementUploads.bankAccountId,
        originalFileName: bankStatementUploads.originalFileName,
        fileUrl: bankStatementUploads.fileUrl,
        periodStart: bankStatementUploads.periodStart,
        periodEnd: bankStatementUploads.periodEnd,
        openingBalance: bankStatementUploads.openingBalance,
        closingBalance: bankStatementUploads.closingBalance,
        totalDebit: bankStatementUploads.totalDebit,
        totalCredit: bankStatementUploads.totalCredit,
        status: bankStatementUploads.status,
        parsingMetadata: bankStatementUploads.parsingMetadata,
        createdAt: bankStatementUploads.createdAt,
        updatedAt: bankStatementUploads.updatedAt,
      })
      .from(bankStatementUploads)
      .where(and(...filters))
      .orderBy(desc(bankStatementUploads.createdAt));

    return reply.send({ uploads });
  });

  // Detail view: one upload + its transactions + match status map
  server.get('/bank-statements/:uploadId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
    const uploadId = Number((request.params as { uploadId: string }).uploadId);
    if (isNaN(uploadId)) return reply.status(400).send({ error: 'Invalid uploadId' });

    const [upload] = await db.select().from(bankStatementUploads).where(eq(bankStatementUploads.id, uploadId));
    if (!upload || upload.deletedAt) return reply.status(404).send({ error: 'Not found' });
    if (upload.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });

    const account = upload.bankAccountId
      ? (await db.select().from(bankAccounts).where(eq(bankAccounts.id, upload.bankAccountId)))[0]
      : null;

    const transactions = await db
      .select()
      .from(bankTransactions)
      .where(and(eq(bankTransactions.statementUploadId, uploadId), isNull(bankTransactions.deletedAt)));

    const matchRows = transactions.length
      ? await db
          .select({
            id: transactionReceiptMatches.id,
            transactionId: transactionReceiptMatches.transactionId,
            receiptId: transactionReceiptMatches.receiptId,
            userAction: transactionReceiptMatches.userAction,
            confidenceScore: transactionReceiptMatches.confidenceScore,
          })
          .from(transactionReceiptMatches)
          .where(inArray(transactionReceiptMatches.transactionId, transactions.map((t) => t.id)))
      : [];

    const matchByTxId = new Map<number, typeof matchRows>();
    for (const m of matchRows) {
      if (!matchByTxId.has(m.transactionId)) matchByTxId.set(m.transactionId, []);
      matchByTxId.get(m.transactionId)!.push(m);
    }

    const errors = await db
      .select()
      .from(processingErrors)
      .where(and(eq(processingErrors.uploadType, 'bank_statement'), eq(processingErrors.uploadId, uploadId)));

    return reply.send({
      upload: {
        ...upload,
        account,
      },
      transactions: transactions.map((t) => ({
        ...t,
        matches: matchByTxId.get(t.id) ?? [],
      })),
      errors,
    });
  });
}
