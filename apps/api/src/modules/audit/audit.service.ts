import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/auth-context';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';

export interface AuditEntry {
  tenantId?: string | null;
  actorUserId?: string | null;
  actorMembershipId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
}

/**
 * Append-only audit trail for security-relevant actions: sign-ins, member changes, exports,
 * recording access, monitoring, settings and integration changes, platform actions.
 * Metadata must not contain secrets or full phone numbers.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma.system;
    try {
      await client.auditLog.create({
        data: {
          tenantId: entry.tenantId ?? null,
          actorUserId: entry.actorUserId ?? null,
          actorMembershipId: entry.actorMembershipId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          metadata: entry.metadata,
          ip: entry.ip?.slice(0, 64),
        },
      });
    } catch (err) {
      if (tx) throw err;
      this.logger.error(`Failed to write audit log ${entry.action}: ${(err as Error).message}`);
    }
  }

  fromCtx(ctx: RequestContext, action: string, entityType?: string, entityId?: string, metadata?: Prisma.InputJsonValue, tx?: Tx): Promise<void> {
    return this.log({ tenantId: ctx.tenantId, actorUserId: ctx.user.id, actorMembershipId: ctx.membershipId, action, entityType, entityId, metadata, ip: ctx.ip }, tx);
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
