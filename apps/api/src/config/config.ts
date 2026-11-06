import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const isProd = process.env.NODE_ENV === 'production';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  /** HMAC key for signed URLs (recording playback). At least 32 characters. */
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  /** Base64-encoded 32-byte key for AES-256-GCM encryption of tenant provider secrets. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
  /** Public HTTPS origin Plivo and Meta call back to; webhooks live under <PUBLIC_BASE_URL>/api/webhooks. */
  PUBLIC_BASE_URL: z.url().transform((v) => v.replace(/\/+$/, '')),
  /** Comma-separated browser origins allowed for CORS / Socket.IO / CSRF origin checks. */
  WEB_ORIGIN: z.string().min(1).transform((v) => v.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)),
  COOKIE_SECURE: bool(isProd),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  TELEPHONY_DEFAULT_PROVIDER: z.enum(['mock', 'plivo']).default('mock'),
  /** Allow the simulated telephony provider. Off by default in production. */
  ALLOW_MOCK_PROVIDER: bool(!isProd),
  /** Enables simulation controls (force busy/no-answer) for mock calls. */
  ALLOW_MOCK_CONTROLS: bool(!isProd),
  /** Optional platform-owned Plivo account used for tenants without their own credentials. */
  PLIVO_AUTH_ID: z.string().optional(),
  PLIVO_AUTH_TOKEN: z.string().optional(),
  PLIVO_CALLER_ID: z.string().optional(),
  PLIVO_BROWSER_SIP_URI_TEMPLATE: z.string().default('sip:{identity}@phone.plivo.com'),
  PLIVO_API_TIMEOUT_MS: z.coerce.number().int().default(10000),
  WHATSAPP_ALLOW_MOCK: bool(!isProd),
  WHATSAPP_GRAPH_BASE_URL: z.url().default('https://graph.facebook.com'),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Calling CRM <no-reply@localhost>'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(false),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(!isProd),
  ENABLE_API_DOCS: bool(!isProd),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /** Disable repeatable maintenance jobs (used by tests that drive sweeps directly). */
  DISABLE_SCHEDULERS: bool(false),
  /** Speed multiplier for simulated call timings (tests use a small value). */
  MOCK_TIME_SCALE: z.coerce.number().min(0.001).max(10).default(1),
});

export type Env = z.infer<typeof envSchema>;

let loaded = false;
/** Load `.env` from the working directory for local development (never required in production). */
export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = resolve(process.cwd(), '.env');
  if (process.env.NODE_ENV !== 'production' && existsSync(file) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  const env = result.data;
  if (env.NODE_ENV === 'production') {
    if (!env.PUBLIC_BASE_URL.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use https in production');
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  }
  if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  return env;
}

/** Injectable, immutable view of validated configuration. */
export class AppConfig {
  readonly env: Env;
  constructor(env?: Env) {
    loadDotEnv();
    this.env = env ?? parseEnv();
  }
  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }
  webhookUrl(path: string): string {
    return `${this.env.PUBLIC_BASE_URL}/api/webhooks${path.startsWith('/') ? path : `/${path}`}`;
  }
}
