import { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import { db, receipts, receiptUploads } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Replicate __dirname functionality in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function fileRoutes(
  server: FastifyInstance,
) {
  server.get('/files/:filename', { preHandler: [authenticate] }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const publicImageUrl = `/files/${filename}`;

    try {
      // Find the receipt associated with this file, and its parent upload
      const receipt = await db.query.receipts.findFirst({
        where: eq(receipts.imageUrl, publicImageUrl),
        with: {
          upload: {
            columns: {
              userId: true
            }
          }
        }
      });

      if (!receipt || !receipt.upload) {
        // Also check if it's an original or marked image from the uploads table
        const upload = await db.query.receiptUploads.findFirst({
          where: eq(receiptUploads.originalImageUrl, publicImageUrl) || eq(receiptUploads.markedImageUrl, publicImageUrl),
          columns: { userId: true },
        });

        if (!upload) {
          return reply.status(404).send({ error: 'File not found.' });
        }
        
        // Authorize for upload images
        if (request.user?.id !== upload.userId && !request.isInternal) {
          return reply.status(403).send({ error: 'Forbidden.' });
        }

      } else {
        // Authorize for receipt images
        if (request.user?.id !== receipt.upload.userId && !request.isInternal) {
          return reply.status(403).send({ error: 'Forbidden.' });
        }
      }

      // Authorized, now stream the file
      const filePath = path.join(__dirname, '../../../uploads', filename);
      
      if (!fs.existsSync(filePath)) {
          // This case can happen if the file is in the DB but deleted from disk
          request.log.error(`File ${filePath} not found on disk, but exists in DB.`);
          return reply.status(404).send({ error: 'File not found.' });
      }
      
      const stream = fs.createReadStream(filePath);
      // Let Fastify handle the content type
      return reply.send(stream);

    } catch (error) {
      request.log.error(error, `Error serving file ${filename}`);
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
  });
}
