import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import userRoutes from './routes/users.js';
import fileRoutes from './routes/files.js';
import imageProcessingRoutes from './routes/image-processing.js';
// Set up a conditional logger. Use pino-pretty in development, default JSON in production.
const loggerConfig = process.env.NODE_ENV === 'development' ? {
    transport: {
        target: 'pino-pretty',
        options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
        },
    },
} : true;
const server = Fastify({
    logger: loggerConfig,
});
async function main() {
    // Register plugins
    server.register(multipart, {
        limits: {
            fileSize: 10 * 1024 * 1024, // 10 MB limit
        },
    });
    // Register health check
    server.get('/health', async (_, __) => {
        return { status: 'ok' };
    });
    // Register routes
    server.register(userRoutes, { prefix: '/api' });
    server.register(fileRoutes, { prefix: '/api' });
    server.register(imageProcessingRoutes, { prefix: '/api' });
    // Start the server
    try {
        const port = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 3000;
        await server.listen({ port, host: '0.0.0.0' });
        console.log(`API server listening at http://0.0.0.0:${port}`);
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
}
main();
