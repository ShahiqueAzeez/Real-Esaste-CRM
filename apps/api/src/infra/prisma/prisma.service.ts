import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfig } from '../../config/config';
import { tenantGuardExtension } from './tenant-guard';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

/**
 * Two views over one connection pool:
 *  - `db`: tenant-guarded client for all request-scoped code.
 *  - `system`: unguarded client for code that must span tenants (webhook resolution, sweeps,
 *    authentication). Every use of `system` should be easy to audit.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');
  readonly system: PrismaClient;
  readonly db: PrismaClient;

  constructor(config: AppConfig) {
    this.system = new PrismaClient({
      datasourceUrl: config.env.DATABASE_URL,
      log: [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
    });
    // The extension only adds runtime checks; the public API is unchanged.
    this.db = this.system.$extends(tenantGuardExtension) as unknown as PrismaClient;
  }

  async onModuleInit(): Promise<void> {
    await this.system.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.system.$disconnect();
  }

  async ping(): Promise<boolean> {
    try {
      await this.system.$queryRaw`SELECT 1`;
      return true;
    } catch (err) {
      this.logger.error(`Database ping failed: ${(err as Error).message}`);
      return false;
    }
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
