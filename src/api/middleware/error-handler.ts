import type { FastifyRequest, FastifyReply, FastifyInstance, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../utils/logger.js';
import { UploadValidationError } from './validate-upload.js';

const log = createLogger('api.error-handler');

/**
 * Global Fastify error handler. Catches anything thrown inside a route and
 * returns a sanitized JSON response — no stack traces leak to the client.
 *
 * Known safe error types get their own status code; everything else is 500.
 *
 * Register via `server.setErrorHandler(buildErrorHandler())` in index.ts.
 */
export function buildErrorHandler() {
  return function errorHandler(
    error: Error & { statusCode?: number; validation?: unknown[] },
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const statusCode =
      error instanceof UploadValidationError
        ? error.statusCode
        : (error.statusCode ?? 500);

    if (statusCode >= 500) {
      log.error(
        { err: error, requestId: request.id, method: request.method, url: request.url },
        'unhandled server error',
      );
    } else {
      log.warn({ statusCode, message: error.message, url: request.url }, 'client error');
    }

    const body: Record<string, unknown> = { error: error.message };

    // Fastify validation errors include a `validation` array — pass it through
    // so clients get field-level detail without exposing stack internals.
    if (Array.isArray(error.validation)) {
      body.validation = error.validation;
    }

    return reply.status(statusCode).send(body);
  };
}

// Re-export so api/index.ts doesn't need to import FastifyInstance just for this
export type ErrorHandlerFn = ReturnType<typeof buildErrorHandler>;
// Satisfy the Fastify.setErrorHandler signature without creating a circular dep
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerErrorHandler(server: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse<IncomingMessage>, any>): void {
  server.setErrorHandler(buildErrorHandler());
}
