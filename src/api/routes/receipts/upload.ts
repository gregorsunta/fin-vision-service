import { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import path from 'path';
import { and, eq } from 'drizzle-orm';
import { authenticate } from '../../auth.js';
import { db } from '../../../db/index.js';
import { receiptUploads } from '../../../db/schema.js';
import { ReceiptJobData, receiptProcessingQueue } from '../../../queue/index.js';
import { compressToWebP, computePerceptualHash, hashFilename, perceptualHashDistance, saveFile } from '../../../utils/file-utils.js';
import { validateImageBuffer } from '../../middleware/validate-upload.js';

/**
 * POST /image/split-and-analyze — main upload entry point.
 *
 * Flow: multipart file → SHA-256 hash → duplicate check (per user) → compress
 * to WebP → save raw + compressed → assign uploadNumber transactionally →
 * enqueue BullMQ job. Duplicates are stored as status='duplicate' (no raw
 * file, no queue enqueue).
 */
export default async function uploadRoutes(server: FastifyInstance) {
  server.post('/image/split-and-analyze', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'User not authenticated.' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'File upload is required.' });
    }

    const imageBuffer = await data.toBuffer();
    await validateImageBuffer(imageBuffer);
    const imageHash = createHash('sha256').update(imageBuffer).digest('hex');

    // Compute perceptual hash for near-duplicate detection (in parallel with exact hash check)
    const [pHash, existingExact] = await Promise.all([
      computePerceptualHash(imageBuffer),
      db
        .select({ id: receiptUploads.id, status: receiptUploads.status })
        .from(receiptUploads)
        .where(and(eq(receiptUploads.userId, request.user.id), eq(receiptUploads.imageHash, imageHash)))
        .then(rows => rows[0] ?? null),
    ]);

    // Near-duplicate check: load all perceptual hashes for this user and compare Hamming distance
    let existingUpload = existingExact;
    if (!existingUpload) {
      const userHashes = await db
        .select({ id: receiptUploads.id, status: receiptUploads.status, perceptualHash: receiptUploads.perceptualHash })
        .from(receiptUploads)
        .where(and(eq(receiptUploads.userId, request.user.id)));

      const PHASH_THRESHOLD = 8; // ≤8 out of 64 bits different → near-duplicate
      for (const row of userHashes) {
        if (row.perceptualHash && perceptualHashDistance(pHash, row.perceptualHash) <= PHASH_THRESHOLD) {
          existingUpload = { id: row.id, status: row.status };
          break;
        }
      }
    }

    const compressedBuffer = await compressToWebP(imageBuffer);
    const { filePath, publicUrl: originalImageUrl } = await saveFile(
      compressedBuffer,
      hashFilename(compressedBuffer, '.webp'),
    );

    const originalFileName = data.filename ? path.basename(data.filename) : null;

    let uploadNumber!: number;
    let uploadId!: number;

    if (existingUpload) {
      // Duplicate — keep compressed copy for display, skip raw and queue.
      await db.transaction(async (tx) => {
        const rows = await tx
          .select({ uploadNumber: receiptUploads.uploadNumber })
          .from(receiptUploads)
          .where(eq(receiptUploads.userId, request.user!.id))
          .for('update');
        uploadNumber = rows.reduce((m, u) => Math.max(m, u.uploadNumber), 0) + 1;
        const result = await tx.insert(receiptUploads).values({
          userId: request.user!.id,
          uploadNumber,
          originalImageUrl,
          imageHash,
          perceptualHash: pHash,
          originalFileName,
          status: 'duplicate',
          updatedAt: new Date(),
        });
        uploadId = result[0].insertId;
      });

      return reply.status(202).send({
        uploadId,
        uploadNumber,
        message: 'Duplicate upload detected',
        duplicateOfUploadId: existingUpload.id,
        statusUrl: `/receipts/${uploadId}`,
      });
    }

    // Preserve the raw original for archival (can be cleaned up via settings later)
    const originalExt = data.filename ? path.extname(data.filename) || '.jpg' : '.jpg';
    const { publicUrl: rawImageUrl } = await saveFile(imageBuffer, hashFilename(imageBuffer, `-raw${originalExt}`));

    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ uploadNumber: receiptUploads.uploadNumber })
        .from(receiptUploads)
        .where(eq(receiptUploads.userId, request.user!.id))
        .for('update');
      uploadNumber = rows.reduce((m, u) => Math.max(m, u.uploadNumber), 0) + 1;
      const result = await tx.insert(receiptUploads).values({
        userId: request.user!.id,
        uploadNumber,
        originalImageUrl,
        rawImageUrl,
        imageHash,
        perceptualHash: pHash,
        originalFileName,
        status: 'processing',
        updatedAt: new Date(),
      });
      uploadId = result[0].insertId;
    });

    const jobData: ReceiptJobData = {
      uploadId,
      imagePath: filePath,
    };
    await receiptProcessingQueue.add('process-receipt', jobData, {
      jobId: `upload-${uploadId}`,
    });

    return reply.status(202).send({
      uploadId,
      uploadNumber,
      message: 'Upload successful. Receipt processing has been queued.',
      statusUrl: `/receipts/${uploadId}`,
    });
  });
}
