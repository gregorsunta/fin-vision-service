import '../db/index.js'; // Ensure DB connection is initialized
import receiptProcessorWorker from './receiptProcessor.js';
import { createLogger } from '../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const log = createLogger('worker.bootstrap');

log.info('worker process started, listening for receipt processing jobs');

const gracefulShutdown = () => {
    log.info('shutting down worker gracefully');
    receiptProcessorWorker.close().then(() => {
        log.info('worker has been closed');
        process.exit(0);
    }).catch(err => {
        log.error({ err }, 'error during worker shutdown');
        process.exit(1);
    });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
