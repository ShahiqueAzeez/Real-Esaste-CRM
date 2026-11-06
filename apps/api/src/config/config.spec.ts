import { parseEnv } from './config';

const base = {
  DATABASE_URL: 'postgresql://crm:pw@localhost:5432/crm',
  REDIS_URL: 'redis://localhost:6379/0',
  APP_SECRET: 'x'.repeat(48),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  WEB_ORIGIN: 'https://crm.example.com',
};

describe('parseEnv', () => {
  it('accepts a complete production configuration served over https', () => {
    const env = parseEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://crm.example.com/', COOKIE_SECURE: 'true' });
    expect(env.PUBLIC_BASE_URL).toBe('https://crm.example.com');
    expect(env.WEB_ORIGIN).toEqual(['https://crm.example.com']);
  });

  it('rejects plain http for a public host in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://crm.example.com', COOKIE_SECURE: 'true' })).toThrow(
      /must use https in production/,
    );
  });

  it('accepts plain http only for a loopback host in production', () => {
    for (const url of ['http://localhost:8080', 'http://127.0.0.1:8080']) {
      expect(parseEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: url, COOKIE_SECURE: 'true' }).PUBLIC_BASE_URL).toBe(url);
    }
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://localhost.example.com', COOKIE_SECURE: 'true' })).toThrow();
  });

  it('always requires secure cookies in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://crm.example.com', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    );
  });

  it('rejects weak or malformed secrets', () => {
    expect(() => parseEnv({ ...base, PUBLIC_BASE_URL: 'http://localhost:3000', APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
    expect(() => parseEnv({ ...base, PUBLIC_BASE_URL: 'http://localhost:3000', DATA_ENCRYPTION_KEY: 'bm90LTMyLWJ5dGVz' })).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
