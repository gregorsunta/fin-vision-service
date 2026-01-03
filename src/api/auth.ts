import { FastifyReply, FastifyRequest } from 'fastify';
import { db, users } from '../db/index.js';
import { eq } from 'drizzle-orm';

// Define the shape of the user object that will be attached to the request
export interface AuthenticatedUser {
  id: number;
}

// Define the shape of what our auth hook will attach to the request
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    isInternal?: boolean;
  }
}

/**
 * A Fastify hook to protect routes. It checks for a valid user API key
 * or the internal service-to-service API key.
 *
 * It populates `request.user` or `request.isInternal` if auth is successful.
 *
 * @param request The Fastify request object.
 * @param reply The Fastify reply object.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['authorization'];

  if (!apiKey) {
    return reply.status(401).send({ error: 'Authorization header is missing.' });
  }

  // Check if it's the internal service key
  if (apiKey === process.env.INTERNAL_API_KEY) {
    request.isInternal = true;
    return; // Success
  }

  // Otherwise, look for a user with this key
  try {
    const userResult = await db.query.users.findFirst({
      where: eq(users.apiKey, apiKey),
      columns: { id: true },
    });

    if (!userResult) {
      return reply.status(401).send({ error: 'Invalid API Key.' });
    }

    request.user = { id: userResult.id };
  } catch (error) {
    request.log.error(error, 'Error during authentication lookup');
    return reply.status(500).send({ error: 'Internal Server Error' });
  }
}
