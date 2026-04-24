import { FastifyInstance } from 'fastify';
import { eq, or } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import { duplicateMatches, lineItems, processingErrors, receiptUploads, receipts } from '../../../db/schema.js';
import { deleteFile } from '../../../utils/file-utils.js';

/**
 * DELETE /receipts/:uploadId — hard delete of an upload and everything
 * downstream (receipts, line items, duplicate matches, processing errors)
 * plus on-disk image files.
 *
 * NOTE: This is NOT a soft delete. Uploads that a user explicitly removes are
 * fully wiped. Per-receipt soft delete lives in `receipt-editing.ts`.
 */
export default async function deleteRoutes(server: FastifyInstance) {
  server.delete('/receipts/:uploadId', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const { uploadId } = request.params as { uploadId: string };
    const uploadIdNum = parseInt(uploadId, 10);

    if (isNaN(uploadIdNum)) {
      return reply.status(400).send({ error: 'Invalid upload ID.' });
    }

    const [upload] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));
    if (!upload) {
      return reply.status(404).send({ error: 'Receipt upload not found.' });
    }
    if (upload.userId !== request.user.id) {
      return reply.status(403).send({ error: 'Forbidden.' });
    }

    const existingReceipts = await db.select().from(receipts).where(eq(receipts.uploadId, uploadIdNum));
    for (const receipt of existingReceipts) {
      await db.delete(lineItems).where(eq(lineItems.receiptId, receipt.id));
      await db
        .delete(duplicateMatches)
        .where(
          or(
            eq(duplicateMatches.receiptId, receipt.id),
            eq(duplicateMatches.potentialDuplicateId, receipt.id),
          ),
        );
      if (receipt.imageUrl) {
        await deleteFile(receipt.imageUrl);
      }
    }

    await db.delete(receipts).where(eq(receipts.uploadId, uploadIdNum));
    await db.delete(processingErrors).where(eq(processingErrors.uploadId, uploadIdNum));

    if (upload.rawImageUrl) {
      await deleteFile(upload.rawImageUrl);
    }
    if (upload.originalImageUrl) {
      await deleteFile(upload.originalImageUrl);
    }
    if (upload.markedImageUrl) {
      await deleteFile(upload.markedImageUrl);
    }

    await db.delete(receiptUploads).where(eq(receiptUploads.id, uploadIdNum));

    return reply.send({ message: 'Upload and all related data deleted.' });
  });
}
