import { FastifyInstance } from 'fastify';
import { ReceiptAnalysisService } from '../../../services/receipt-analysis.js';

/**
 * POST /ocr/test — DEVELOPMENT-ONLY endpoint, no auth.
 *
 * Accepts a multipart image and returns raw OCR output (Vision + Tesseract
 * merged) without saving anything. Used for tuning the preprocess pipeline
 * and comparing OCR engines. Must NOT be exposed in production.
 *
 * TODO(faza 4): guard with NODE_ENV !== 'production' or remove entirely.
 */
export default async function ocrTestRoutes(server: FastifyInstance) {
  server.post('/ocr/test', async (request, reply) => {
    const { preprocess } = request.query as { preprocess?: string };
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'File upload is required.' });
    }
    const imageBuffer = await data.toBuffer();
    const analysisService = new ReceiptAnalysisService();
    const result = await analysisService.extractTextDebug(imageBuffer, preprocess !== 'false');
    if (result.merged === null) {
      return reply.status(422).send({ error: 'OCR failed to extract text from the image.' });
    }
    return reply.send(result);
  });
}
