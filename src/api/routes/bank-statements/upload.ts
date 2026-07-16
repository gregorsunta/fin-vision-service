import { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import path from 'path';
import { and, eq, isNull } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import { bankAccounts, bankStatementUploads } from '../../../db/schema.js';
import { BankStatementJobData, bankStatementProcessingQueue } from '../../../queue/index.js';
import { saveFile } from '../../../utils/file-utils.js';

const ACCEPTED_MIMES = new Set([
  'application/pdf',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_BYTES = 20 * 1024 * 1024;

function extFromMimeOrName(mime: string, name: string | undefined): string {
  if (mime === 'application/pdf') return '.pdf';
  if (mime === 'text/csv' || mime === 'application/csv') return '.csv';
  if (mime === 'application/vnd.ms-excel') return '.xls';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
  return name ? path.extname(name) : '';
}

export default async function bankStatementUploadRoutes(server: FastifyInstance) {
  server.post('/bank-statements/upload', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });

    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'File required' });

    const buffer = await data.toBuffer();
    if (buffer.length > MAX_BYTES) {
      return reply.status(413).send({ error: `File too large. Max ${MAX_BYTES / 1024 / 1024} MB.` });
    }

    const mimeType = data.mimetype;
    if (!ACCEPTED_MIMES.has(mimeType)) {
      return reply.status(400).send({ error: `Unsupported type: ${mimeType}. Allowed: PDF, CSV, XLSX.` });
    }

    const fileHash = createHash('sha256').update(buffer).digest('hex');

    // Exact-file duplicate: same SHA-256 already uploaded by this user. We
    // don't rerun parsing — the previous upload's transactions are still in
    // place.
    const [existing] = await db
      .select({ id: bankStatementUploads.id })
      .from(bankStatementUploads)
      .where(and(
        eq(bankStatementUploads.userId, request.user.id),
        eq(bankStatementUploads.fileHash, fileHash),
        isNull(bankStatementUploads.deletedAt),
      ));

    // Validate requested bank account ownership if one was provided.
    const bodyBankAccountId = (request.query as { bankAccountId?: string }).bankAccountId;
    let bankAccountId: number | null = null;
    if (bodyBankAccountId) {
      const parsed = Number(bodyBankAccountId);
      if (isNaN(parsed)) return reply.status(400).send({ error: 'Invalid bankAccountId' });
      const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, parsed));
      if (!account || account.deletedAt) return reply.status(404).send({ error: 'Bank account not found' });
      if (account.userId !== request.user.id) return reply.status(403).send({ error: 'Forbidden' });
      bankAccountId = parsed;
    }

    const ext = extFromMimeOrName(mimeType, data.filename);
    const storedName = `${fileHash}${ext}`;
    const { filePath, publicUrl } = await saveFile(buffer, storedName);

    let uploadId!: number;
    let uploadNumber!: number;
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ uploadNumber: bankStatementUploads.uploadNumber })
        .from(bankStatementUploads)
        .where(eq(bankStatementUploads.userId, request.user!.id))
        .for('update');
      uploadNumber = rows.reduce((m, u) => Math.max(m, u.uploadNumber), 0) + 1;

      const result = await tx.insert(bankStatementUploads).values({
        userId: request.user!.id,
        bankAccountId,
        uploadNumber,
        originalFileName: data.filename ?? null,
        fileUrl: publicUrl,
        rawFileUrl: publicUrl,
        fileHash,
        mimeType,
        status: existing ? 'duplicate' : 'processing',
      });
      uploadId = result[0].insertId;
    });

    if (existing) {
      return reply.status(202).send({
        uploadId,
        uploadNumber,
        status: 'duplicate',
        duplicateOfUploadId: existing.id,
        statusUrl: `/api/bank-statements/${uploadId}`,
      });
    }

    const job: BankStatementJobData = {
      uploadId,
      filePath,
      mimeType,
      originalFileName: data.filename ?? undefined,
    };
    await bankStatementProcessingQueue.add('process-statement', job, { jobId: `bank-statement-${uploadId}` });

    return reply.status(202).send({
      uploadId,
      uploadNumber,
      status: 'processing',
      statusUrl: `/api/bank-statements/${uploadId}`,
    });
  });
}
