import '../db/index.js'; // Ensure DB connection is initialized
import receiptProcessorWorker from './receiptProcessor.js';
import dotenv from 'dotenv';

dotenv.config();

console.log('Worker process started. Listening for receipt processing jobs...');

const gracefulShutdown = () => {
    console.log('Shutting down worker gracefully...');
    receiptProcessorWorker.close().then(() => {
        console.log('Worker has been closed.');
        process.exit(0);
    }).catch(err => {
        console.error('Error during worker shutdown:', err);
        process.exit(1);
    });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
