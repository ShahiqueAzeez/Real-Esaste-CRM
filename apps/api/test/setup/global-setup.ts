import { execSync } from 'node:child_process';
import IORedis from 'ioredis';
import { TEST_ENV } from './test-env';

/**
 * Bring the test database up to the current migrations (non-destructive) and clear test-prefixed
 * Redis keys. Test files isolate themselves by creating uniquely named organizations, so no data
 * wipe is required between runs.
 */
export default async function globalSetup(): Promise<void> {
  if (!/crm_test|_test\b/.test(TEST_ENV.DATABASE_URL!)) throw new Error('Integration tests must run against a database whose name ends in _test');
  execSync('npx prisma migrate deploy', {
    cwd: `${__dirname}/../..`,
    env: { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
  const redis = new IORedis(TEST_ENV.REDIS_URL!);
  for (const pattern of ['crm-test:*', 'crm:throttle:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  }
  await redis.quit();
}
