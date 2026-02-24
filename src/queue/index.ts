import { Queue } from 'bullmq';
import dotenv from 'dotenv';

dotenv.config();

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
};

// Define a new queue for processing receipts
export const receiptProcessingQueue = new Queue('receipt-processing', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 30000, // 30s → 60s → 120s, gives rate limits time to recover
    },
  },
});

// Interface for the job data
export interface ReceiptJobData {
  uploadId: number;
  imagePath: string;
  receiptId?: number;
  receiptImagePath?: string;
}
