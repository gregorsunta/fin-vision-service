import { FastifyInstance } from 'fastify';
import { db, users, receiptUploads, receipts } from '../../db/index.js';
import { randomBytes } from 'crypto';
import { authenticate } from '../auth.js';
import { generateReceiptsCsv } from '../../services/csvGenerator.js';
import { eq, inArray } from 'drizzle-orm';

// Define a placeholder type that matches what generateReceiptsCsv expects.
type Receipt = any;

export default async function userRoutes(
  server: FastifyInstance,
) {
  // Route to create a new user and get an API key
  server.post('/users', async (request, reply) => {
    try {
      const newApiKey = `usk_${randomBytes(24).toString('hex')}`;

      const result = await db
        .insert(users)
        .values({
          apiKey: newApiKey,
        })
        .execute();

      reply.status(201).send({
        userId: result[0].insertId,
        apiKey: newApiKey,
        message: 'User created successfully. Store this API key securely.',
      });
    } catch (error) {
      request.log.error(error, 'Failed to create new user');
      reply.status(500).send({ error: 'Could not create user.', details: error });
    }
  });

  // Route to export all receipt data for the authenticated user as CSV
  server.get('/users/me/receipts/export-csv', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Authentication required.' });
    }

    try {
      // Step 1: Find all upload IDs for the current user
      const userUploads = await db.select({ id: receiptUploads.id }).from(receiptUploads).where(eq(receiptUploads.userId, request.user.id));
      
      if (userUploads.length === 0) {
        return reply.status(404).send({ message: 'No receipt uploads found for this user.' });
      }

      const uploadIds = userUploads.map(u => u.id);

      // Step 2: Fetch all receipts associated with those upload IDs, along with their line items
      const userReceipts: Receipt[] = await db.query.receipts.findMany({
        where: inArray(receipts.uploadId, uploadIds),
        with: {
          lineItems: true,
        },
      });

      if (!userReceipts || userReceipts.length === 0) {
        return reply.status(404).send({ message: 'No processed receipts found for this user.' });
      }

      // Generate CSV from the fetched data
      const csv = generateReceiptsCsv(userReceipts);

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="user_${request.user.id}_receipts_export.csv"`);
      reply.send(csv);

    } catch (error) {
      request.log.error(error, 'Failed to export user receipts to CSV');
      reply.status(500).send({ error: 'Could not export receipts to CSV.', details: error });
    }
  });
}


