import 'dotenv/config';
import { Queue, ConnectionOptions } from 'bullmq';

if (!process.env.REDIS_HOST || !process.env.REDIS_PORT) {
    throw new Error('REDIS_HOST and REDIS_PORT must be set in the environment variables');
}

export const redisConnection: ConnectionOptions = {
    host: process.env.NODE_ENV === 'development' ? 'localhost' : process.env.REDIS_HOST || 'localhost',
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
