import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { map, type Observable } from 'rxjs';

/** Fields that must never leave the server, even if a query selects them by mistake. */
const SECRET_FIELDS = new Set(['passwordHash', 'tokenHash', 'csrfTokenHash', 'secretsEncrypted', 'providerUrl']);

export function toJsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 25) return null;
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal) return value.toString();
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(k)) continue;
      out[k] = toJsonSafe(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Converts BigInt/Decimal for JSON and strips secret fields from every JSON response. */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => (typeof data === 'string' || Buffer.isBuffer(data) ? data : toJsonSafe(data))));
  }
}
