import { Controller, Get, HttpCode, Inject, Module, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type IORedis from 'ioredis';
import { Public } from '../../common/auth-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { REDIS } from '../../infra/redis/redis.module';

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  /** Liveness: the process is up. */
  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Returns 503 when PostgreSQL or Redis is down. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [db, redis] = await Promise.all([
      this.prisma.ping(),
      this.redis.ping().then((r) => r === 'PONG').catch(() => false),
    ]);
    const ok = db && redis;
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks: { database: db ? 'ok' : 'down', redis: redis ? 'ok' : 'down' } };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
