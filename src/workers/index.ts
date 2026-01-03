import { Worker } from 'bullmq';
import { redisConnection, RECEIPT_PROCESSING_QUEUE } from '../queue/index.js';
import path from 'path';
import { fileURLToPath } from 'url';

// Replicate __dirname functionality in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Worker process started...');

const worker = new Worker(
  RECEIPT_PROCESSING_QUEUE,
  path.join(__dirname, 'receipt-processor.js'), // Use the compiled JS file
  {
    connection: redisConnection,
    concurrency: 5, // Process up to 5 jobs concurrently
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} has completed successfully.`);
});

worker.on('failed', (job, err) => {
  if (job) {
    console.error(`Job ${job.id} has failed with error: ${err.message}`);
    console.error(err.stack);
  } else {
    console.error(`A job has failed with error: ${err.message}`);
  }
});

worker.on('error', (err) => {
  console.error('Worker encountered an error:', err);
});

process.on('SIGINT', () => {
    console.log('Gracefully shutting down worker...');
    worker.close();
});
