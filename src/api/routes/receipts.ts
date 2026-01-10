import { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';

export default async function receiptRoutes(
  server: FastifyInstance,
) {
  server.post('/receipts', { preHandler: [authenticate] }, async (_request, reply) => {
    // This endpoint is deprecated and all logic has been moved to /api/image/split-and-analyze
    return reply.status(400).send({
      error: 'This endpoint is deprecated. Please use /api/image/split-and-analyze for full processing.',
    });
  });
}