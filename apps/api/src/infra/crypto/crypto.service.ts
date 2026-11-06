import { Global, Injectable, Module } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/config';

@Injectable()
export class CryptoService {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(config: AppConfig) {
    this.encKey = Buffer.from(config.env.DATA_ENCRYPTION_KEY, 'base64');
    this.hmacKey = Buffer.from(config.env.APP_SECRET, 'utf8');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  /** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url parts). */
  encryptJson(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decryptJson<T = Record<string, unknown>>(payload: string): T {
    const [version, iv, tag, ct] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }

  /** Short-lived signed token: base64url(json).base64url(hmac). */
  sign(payload: Record<string, unknown>, ttlSeconds: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    const mac = createHmac('sha256', this.hmacKey).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify<T extends Record<string, unknown>>(token: string): T | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', this.hmacKey).update(body).digest('base64url');
    if (!this.safeEqual(mac, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
      if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Mask a secret for display: keeps the last 4 characters. */
  mask(secret: string | undefined | null): string | null {
    if (!secret) return null;
    return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
  }
}

@Global()
@Module({ providers: [CryptoService], exports: [CryptoService] })
export class CryptoModule {}
