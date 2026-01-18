import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, UserPayload } from '../services/authService.js';

// Define the shape of what our auth hook will attach to the request
declare module 'fastify' {
  interface FastifyRequest {
    user?: UserPayload;
    isInternal?: boolean;
  }
}

/**
 * A Fastify hook to protect routes. It checks for a valid JWT access token
 * or the internal service-to-service API key.
 *
 * It populates `request.user` or `request.isInternal` if auth is successful.
 *
 * @param request The Fastify request object.
 * @param reply The Fastify reply object.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers['authorization'];

  if (!authHeader) {
    return reply.status(401).send({ error: 'Authorization header is missing.' });
  }

  // Check if it's the internal service key first
  if (authHeader === process.env.INTERNAL_API_KEY) {
    request.isInternal = true;
    return; // Success for internal service
  }

  // Check for a JWT Bearer token
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return reply.status(401).send({ error: 'Invalid authorization format. Expected "Bearer <token>".' });
  }

  try {
    const decoded = verifyToken<UserPayload>(token, process.env.JWT_SECRET!);
    request.user = decoded;
  } catch (error) {
    request.log.warn(error, 'JWT verification failed');
    return reply.status(401).send({ error: 'Invalid or expired access token.' });
  }
}
