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

export const bankStatementProcessingQueue = new Queue('bank-statement-processing', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
  },
});

export interface BankStatementJobData {
  uploadId: number;
  filePath: string;
  mimeType: string;
  originalFileName?: string;
}

// Phase 2 queue. Only the explicit user-confirm endpoint is allowed to enqueue here.
// The Phase 1 worker has no producer reference to this queue, by design — that is one of
// the seven layers of the GDPR review gate. See workers/bankStatementAiSendProcessor.ts.
export const bankStatementAiSendQueue = new Queue('bank-statement-ai-send', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },
  },
});

export interface BankStatementAiSendJobData {
  uploadId: number;
}
