import 'dotenv/config';
import { Queue } from 'bullmq';
if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is not set in the environment variables');
}
export const redisConnection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
};
// The queue name should be descriptive
export const RECEIPT_PROCESSING_QUEUE = 'receipt-processing';
export const receiptQueue = new Queue(RECEIPT_PROCESSING_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
    },
});
