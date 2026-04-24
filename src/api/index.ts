import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import userRoutes from './routes/users.js';
import fileRoutes from './routes/files.js';
import imageProcessingRoutes from './routes/image-processing.js';
import receiptEditingRoutes from './routes/receipt-editing.js';
import { autoResumeEligibleUploads } from '../services/resumeProcessing.js';
import { getConfig } from '../config/index.js';
import { createLogger, getRootLogger } from '../utils/logger.js';
import { registerErrorHandler } from './middleware/error-handler.js';

const log = createLogger('api.bootstrap');

const server = Fastify({
  loggerInstance: getRootLogger(),
});

async function main() {
  // ── Plugins ──────────────────────────────────────────────────────────────
  await server.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB — primary guard; validate-upload.ts checks again
    },
  });
  await server.register(cookie);

  // Per-IP rate limit: 60 requests/minute globally. Upload route can be
  // tightened further at the route level if needed. Uses in-memory store
  // (single instance); swap to Redis store for multi-instance deployments.
  await server.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      error: 'Too many requests. Please wait a moment before trying again.',
    }),
  });

  // Global error handler — logs and returns sanitized JSON, no stack traces.
  registerErrorHandler(server);

  // ── Routes ───────────────────────────────────────────────────────────────
  server.get('/health', async () => ({ status: 'ok' }));

  server.register(userRoutes, { prefix: '/api' });
  server.register(fileRoutes, { prefix: '/api' });
  server.register(imageProcessingRoutes, { prefix: '/api' });
  server.register(receiptEditingRoutes, { prefix: '/api' });

  // ── Start ─────────────────────────────────────────────────────────────────
  const port = getConfig().API_PORT;
  await server.listen({ port, host: '0.0.0.0' });
  log.info({ port }, 'API server listening');

  // Auto-resume scheduler: every 60 s, re-queue rate-limited receipts whose
  // resetTime has passed for users with autoResumeRateLimited enabled.
  const resumeInterval = setInterval(async () => {
    try {
      await autoResumeEligibleUploads();
    } catch (err) {
      log.error({ err }, 'auto-resume scheduler error');
    }
  }, 60_000);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    clearInterval(resumeInterval);
    try {
      await server.close();
      log.info('API server closed');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during API shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Pre-listen startup errors (plugin registration, port bind, etc.)
  console.error('fatal startup error:', err);
  process.exit(1);
});
