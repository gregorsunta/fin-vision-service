import { z } from 'zod';

const boolish = z
  .union([z.string(), z.boolean(), z.undefined()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === '') return undefined;
    return v.toLowerCase() === 'true' || v === '1';
  });

const intish = (defaultValue: number, opts: { min?: number; max?: number } = {}) =>
  z
    .union([z.string(), z.number(), z.undefined()])
    .transform((v, ctx) => {
      if (v === undefined || v === '') return defaultValue;
      const n = typeof v === 'number' ? v : parseInt(v, 10);
      if (Number.isNaN(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected integer' });
        return z.NEVER;
      }
      if (opts.min !== undefined && n < opts.min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be >= ${opts.min}` });
        return z.NEVER;
      }
      if (opts.max !== undefined && n > opts.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be <= ${opts.max}` });
        return z.NEVER;
      }
      return n;
    });

const csv = (defaultValue: string[]) =>
  z
    .union([z.string(), z.undefined()])
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return parts.length > 0 ? parts : defaultValue;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // API
  API_PORT: intish(3000, { min: 1, max: 65535 }),

  // DB / queue
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: intish(6379, { min: 1, max: 65535 }),

  // Auth
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  REFRESH_TOKEN_SECRET: z.string().min(1, 'REFRESH_TOKEN_SECRET is required'),
  INTERNAL_API_KEY: z.string().min(1, 'INTERNAL_API_KEY is required'),

  // AI providers
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  AI_FALLBACK_ENABLED: boolish.transform((v) => (v === undefined ? true : v)),
  AI_GEMINI_MODELS: csv(['gemini-2.5-flash', 'gemini-2.5-flash-lite']),
  AI_GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  AI_GEMINI_RATE_LIMIT: intish(1000, { min: 1 }),
  AI_GROQ_RATE_LIMIT: intish(1000, { min: 1 }),
  AI_RECEIPT_DELAY_MS: intish(12_000, { min: 0 }),
  AI_MAX_TRANSIENT_RETRIES: intish(2, { min: 0, max: 10 }),

  // GCP / OCR
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  OCR_PREPROCESS: boolish.transform((v) => (v === undefined ? true : v)),
  TESSERACT_LANGS: csv(['slv', 'eng', 'deu']),
  OSD_MIN_CONFIDENCE: z
    .union([z.string(), z.number(), z.undefined()])
    .transform((v, ctx) => {
      if (v === undefined || v === '') return 0.3;
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isNaN(n) || n < 0 || n > 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OSD_MIN_CONFIDENCE must be a number in [0, 1]' });
        return z.NEVER;
      }
      return n;
    }),

  // CV detector sidecar
  CV_DETECTOR_URL: z.string().url().default('http://localhost:8001'),
  CV_DETECTOR_TIMEOUT_MS: intish(60_000, { min: 1_000 }),
  CV_DETECTOR_HEALTH_TIMEOUT_MS: intish(2_000, { min: 100 }),

  // Worker
  BULLMQ_CONCURRENCY: intish(1, { min: 1, max: 64 }),
  JOB_TIMEOUT_MS: intish(10 * 60_000, { min: 10_000 }),

  // Uploads
  UPLOAD_ROOT: z.string().optional(),
  UPLOAD_MAX_FILE_BYTES: intish(15 * 1024 * 1024, { min: 1024 }),
  UPLOAD_MAX_IMAGE_DIMENSION: intish(8_000, { min: 256 }),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  if (!parsed.data.GEMINI_API_KEY && !parsed.data.GROQ_API_KEY) {
    throw new Error(
      'At least one of GEMINI_API_KEY or GROQ_API_KEY must be set (no AI provider configured).',
    );
  }

  return parsed.data;
}

export function getConfig(): AppConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
