import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type IORedis from 'ioredis';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { SessionGuard } from './common/guards/session.guard';
import { SerializeInterceptor } from './common/interceptors/serialize.interceptor';
import { CoreModule } from './core.module';
import { REDIS } from './infra/redis/redis.module';
import { RedisThrottlerStorage } from './infra/throttler/redis-throttler.storage';
import { FEATURE_MODULES } from './feature-modules';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.controller';

@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: IORedis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    AuthModule,
    HealthModule,
    ...FEATURE_MODULES,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
  ],
})
export class AppModule {}
