import type { Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Env } from '../../config/config';

/**
 * Structured JSON logs. Credentials, cookies, CSRF tokens and personal data (phone numbers,
 * emails, names) are redacted. Request bodies are never logged; webhook query strings are trimmed.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-plivo-signature-v3"]',
  'req.headers["x-plivo-signature-ma-v3"]',
  'req.headers["x-hub-signature-256"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.authToken',
  '*.accessToken',
  '*.appSecret',
  '*.token',
  '*.phone',
  '*.phoneE164',
  '*.email',
  '*.To',
  '*.From',
];

export function loggerParams(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      genReqId: (req: IncomingMessage) => {
        const header = req.headers['x-request-id'];
        return typeof header === 'string' && /^[\w-]{8,64}$/.test(header) ? header : randomUUID();
      },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: (req.url ?? '').split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/api/health/live' || req.url === '/api/health/ready' },
      transport: env.LOG_PRETTY ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } } : undefined,
    },
  };
}
