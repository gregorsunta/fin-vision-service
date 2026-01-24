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
    attempts: 3, // Retry a job up to 3 times if it fails
    backoff: {
      type: 'exponential',
      delay: 1000, // Start with a 1-second delay
    },
  },
});

// Interface for the job data
export interface ReceiptJobData {
  uploadId: number;
  imagePath: string;
}
