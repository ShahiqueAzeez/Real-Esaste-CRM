import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type RedisOptions } from 'ioredis';
import { AppConfig } from '../../config/config';

export const REDIS = Symbol('REDIS');

/** Parse redis[s]://user:pass@host:port/db into ioredis options. */
export function redisOptionsFromUrl(url: string, extra: RedisOptions = {}): RedisOptions {
  const u = new URL(url);
  const db = u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0;
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: Number.isFinite(db) ? db : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    ...extra,
  };
}

@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: IORedis) {}
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new IORedis(redisOptionsFromUrl(config.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false })),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
