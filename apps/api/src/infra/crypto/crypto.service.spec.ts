import { randomBytes } from 'node:crypto';
import { AppConfig } from '../../config/config';
import { CryptoService } from './crypto.service';

const config = { env: { DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_SECRET: 'x'.repeat(40) } } as unknown as AppConfig;

describe('CryptoService', () => {
  const crypto = new CryptoService(config);

  it('round-trips encrypted secrets and detects tampering', () => {
    const ct = crypto.encryptJson({ authToken: 'abc' });
    expect(ct.startsWith('v1.')).toBe(true);
    expect(crypto.decryptJson(ct)).toEqual({ authToken: 'abc' });
    const parts = ct.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => crypto.decryptJson(parts.join('.'))).toThrow();
  });

  it('signs short-lived tokens and rejects tampered or expired ones', () => {
    const t = crypto.sign({ rid: 'r1' }, 60);
    expect(crypto.verify<{ rid: string }>(t)?.rid).toBe('r1');
    expect(crypto.verify(t.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull();
    expect(crypto.verify(crypto.sign({ rid: 'r1' }, -1))).toBeNull();
  });

  it('masks secrets', () => {
    expect(crypto.mask('MAXXXXXXXXXX1234')).toBe('••••1234');
    expect(crypto.mask(null)).toBeNull();
  });
});
