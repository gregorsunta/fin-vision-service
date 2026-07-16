import '../db/index.js'; // Ensure DB connection is initialized
import receiptProcessorWorker from './receiptProcessor.js';
import bankStatementProcessorWorker from './bankStatementProcessor.js';
import bankStatementAiSendWorker from './bankStatementAiSendProcessor.js';
import { createLogger } from '../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const log = createLogger('worker.bootstrap');

log.info('worker process started, listening for receipt + bank-statement jobs');

const gracefulShutdown = () => {
    log.info('shutting down workers gracefully');
    Promise.all([
        receiptProcessorWorker.close(),
        bankStatementProcessorWorker.close(),
        bankStatementAiSendWorker.close(),
    ]).then(() => {
        log.info('workers have been closed');
        process.exit(0);
    }).catch(err => {
        log.error({ err }, 'error during worker shutdown');
        process.exit(1);
    });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
