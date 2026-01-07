import { authenticate } from '../auth.js';
import { db, receipts } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
// Replicate __dirname functionality in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export default async function fileRoutes(server) {
    server.get('/files/:filename', { preHandler: [authenticate] }, async (request, reply) => {
        const { filename } = request.params;
        const publicImageUrl = `/files/${filename}`;
        try {
            // Find the receipt associated with this file
            const receipt = await db.query.receipts.findFirst({
                where: eq(receipts.imageUrl, publicImageUrl),
                columns: { id: true, userId: true },
            });
            if (!receipt) {
                return reply.status(404).send({ error: 'File not found.' });
            }
            // Authorize: Check for internal access or user ownership
            const isOwner = request.user && request.user.id === receipt.userId;
            const isInternal = request.isInternal;
            if (!isOwner && !isInternal) {
                return reply.status(403).send({ error: 'Forbidden.' });
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
        }
        catch (error) {
            request.log.error(error, `Error serving file ${filename}`);
            return reply.status(500).send({ error: 'Internal Server Error' });
        }
    });
}
