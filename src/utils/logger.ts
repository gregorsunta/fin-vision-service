import { pino, type Logger, type LoggerOptions } from 'pino';
import { getConfig } from '../config/index.js';

let rootLogger: Logger | undefined;

function buildRootLogger(): Logger {
  const config = getConfig();

  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: 'fin-vision-service' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'password',
        '*.password',
        'authorization',
        '*.authorization',
        'apiKey',
        '*.apiKey',
        'token',
        '*.token',
        'refreshToken',
        '*.refreshToken',
      ],
      remove: true,
    },
  };

  if (config.NODE_ENV === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    };
  }

  return pino(options);
}

export function getRootLogger(): Logger {
  if (!rootLogger) {
    rootLogger = buildRootLogger();
  }
  return rootLogger;
}

/**
 * Returns a child logger tagged with a module name. Prefer one `createLogger`
 * call per file, at module scope, over inlined child-creation inside hot paths.
 *
 *   const log = createLogger('worker.receiptProcessor');
 *   log.info({ jobId, uploadId }, 'processing upload');
 */
export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return getRootLogger().child({ module, ...bindings });
}

export function resetLoggerForTests(): void {
  rootLogger = undefined;
}
