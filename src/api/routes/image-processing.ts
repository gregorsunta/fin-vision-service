import { FastifyInstance } from 'fastify';
import retrieveRoutes from './receipts/retrieve.js';
import uploadRoutes from './receipts/upload.js';
import reprocessRoutes from './receipts/reprocess.js';
import deleteRoutes from './receipts/delete.js';
import ocrTestRoutes from './receipts/ocr-test.js';

/**
 * Aggregator for all receipt-upload-related routes. Historically this file
 * held every endpoint inline (~790 lines); each responsibility now lives in
 * its own module under `./receipts/`:
 *
 *   - retrieve.ts   GET  /receipts/:uploadId, GET /receipts/:uploadId/receipt/:receiptId
 *   - upload.ts     POST /image/split-and-analyze
 *   - reprocess.ts  POST reprocess (single/whole) + resume + duplicate-override
 *   - delete.ts     DELETE /receipts/:uploadId (hard delete)
 *   - ocr-test.ts   POST /ocr/test (dev-only, no auth)
 *
 * PATCH routes + per-receipt soft delete live in `receipt-editing.ts`.
 */
export default async function imageProcessingRoutes(server: FastifyInstance) {
  await server.register(retrieveRoutes);
  await server.register(uploadRoutes);
  await server.register(reprocessRoutes);
  await server.register(deleteRoutes);
  await server.register(ocrTestRoutes);
}
