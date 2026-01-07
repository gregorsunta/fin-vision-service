import { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import { ImageSplitterService } from '../../services/image-splitter.js';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

// Replicate __dirname functionality in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function imageProcessingRoutes(
  server: FastifyInstance,
) {
  server.post('/image/split', { preHandler: [authenticate] }, async (request, reply) => {
    if (!request.user) {
        return reply.status(403).send({ error: 'This endpoint is for users only.' });
    }

    const data = await request.file();

    if (!data) {
      return reply.status(400).send({ error: 'File upload is required.' });
    }

    const { debug } = request.query as { debug?: string };
    
    const imageBuffer = await data.toBuffer();

    const imageSplitter = new ImageSplitterService();
    const result = await imageSplitter.splitImage(imageBuffer, {
      debug: debug === 'true',
    });

    const uploadedFiles: { url: string }[] = [];
    const uploadPath = path.join(__dirname, '../../../uploads');

    for (const buffer of result.images) {
      const uniqueSuffix = randomBytes(16).toString('hex');
      const extension = path.extname(data.filename) || '.jpg'; // default to .jpg
      const uniqueFilename = `${uniqueSuffix}${extension}`;
      const filePath = path.join(uploadPath, uniqueFilename);

      await fs.promises.writeFile(filePath, buffer);

      const publicImageUrl = `/files/${uniqueFilename}`;
      uploadedFiles.push({ url: publicImageUrl });
    }

    const response: any = {
      message: `${result.images.length} images created.`,
      files: uploadedFiles,
    };

    if (result.debug && result.debug.boundingBoxes) {
      response.debug = {
        boundingBoxes: result.debug.boundingBoxes,
      };
    }

    reply.send(response);
  });
}
