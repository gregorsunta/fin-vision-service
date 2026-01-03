import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import receiptRoutes from './routes/receipts';
import userRoutes from './routes/users';
import fileRoutes from './routes/files';
const server = Fastify({
    logger: {
        transport: {
            target: 'pino-pretty',
            options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
            },
        },
    },
});
async function main() {
    // Register plugins
    server.register(multipart);
    // Register health check
    server.get('/health', async (_, __) => {
        return { status: 'ok' };
    });
    // Register routes
    server.register(userRoutes, { prefix: '/api' });
    server.register(receiptRoutes, { prefix: '/api' });
    server.register(fileRoutes, { prefix: '/api' });
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
