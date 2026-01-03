import { db, users } from '../../db';
import { randomBytes } from 'crypto';
export default async function userRoutes(server) {
    // Route to create a new user and get an API key
    server.post('/users', async (request, reply) => {
        try {
            const newApiKey = `usk_${randomBytes(24).toString('hex')}`;
            const result = await db
                .insert(users)
                .values({
                apiKey: newApiKey,
            })
                .execute();
            reply.status(201).send({
                userId: result[0].insertId,
                apiKey: newApiKey,
                message: 'User created successfully. Store this API key securely.',
            });
        }
        catch (error) {
            request.log.error(error, 'Failed to create new user');
            reply.status(500).send({ error: 'Could not create user.' });
        }
    });
}
