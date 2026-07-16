import { FastifyInstance } from 'fastify';
import uploadRoutes from './upload.js';
import retrieveRoutes from './retrieve.js';
import editRoutes from './edit.js';
import exportRoutes from './export.js';
import reviewRoutes from './review.js';
import resubmitRoutes from './resubmit.js';

/**
 * Aggregator for bank statement routes. Mirrors the pattern used under
 * `routes/receipts/`.
 *
 *  - upload.ts    POST   /bank-statements/upload
 *  - retrieve.ts  GET    /bank-statements, /bank-statements/:uploadId
 *  - edit.ts      PATCH, DELETE endpoints
 *  - review.ts    GDPR review-gate endpoints (preview, confirm-send, cancel)
 */
export default async function bankStatementsRoutes(server: FastifyInstance) {
  await server.register(uploadRoutes);
  await server.register(retrieveRoutes);
  await server.register(editRoutes);
  await server.register(exportRoutes);
  await server.register(reviewRoutes);
  await server.register(resubmitRoutes);
}
