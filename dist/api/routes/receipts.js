import { db, receipts } from '../../db/index.js';
import { receiptQueue } from '../../queue/index.js';
import { pipeline } from 'stream';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { authenticate } from '../auth.js';
import { fileURLToPath } from 'url';
// Replicate __dirname functionality in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pump = promisify(pipeline);
export default async function receiptRoutes(server) {
    server.post('/receipts', { preHandler: [authenticate] }, async (request, reply) => {
        // Ensure this endpoint is only used by authenticated users, not internal services
        if (!request.user) {
            return reply.status(403).send({ error: 'This endpoint is for users only.' });
        }
        const data = await request.file();
        if (!data) {
            return reply.status(400).send({ error: 'File upload is required.' });
        }
        // Generate a unique filename to prevent collisions
        const uniqueSuffix = randomBytes(16).toString('hex');
        const extension = path.extname(data.filename);
        const uniqueFilename = `${uniqueSuffix}${extension}`;
        // Define the path to save the file
        const uploadPath = path.join(__dirname, '../../../uploads', uniqueFilename);
        try {
            // Save the file to the filesystem
            await pump(data.file, fs.createWriteStream(uploadPath));
            // This is the URL that the file will be accessible at
            const publicImageUrl = `/files/${uniqueFilename}`;
            // Create a 'pending' record in the database, associated with the user
            const result = await db
                .insert(receipts)
                .values({
                status: 'pending',
                imageUrl: publicImageUrl,
                userId: request.user.id, // Associate with the authenticated user
            })
                .execute();
            const receiptId = result[0].insertId;
            // Add a job to the queue to process this receipt
            await receiptQueue.add('process-receipt', {
                receiptId: receiptId,
                imageUrl: publicImageUrl,
            });
            // Respond that the job has been accepted for processing
            reply.status(202).send({
                message: 'Receipt accepted for processing.',
                receiptId: receiptId,
                url: publicImageUrl
            });
        }
        catch (error) {
            request.log.error(error);
            reply.status(500).send({ error: 'Failed to save or queue receipt.' });
        }
    });
}
