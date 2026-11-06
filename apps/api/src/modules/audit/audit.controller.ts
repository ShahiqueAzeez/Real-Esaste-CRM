import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { listQuerySchema } from '@crm/shared';
import { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { pageArgs, toPage } from '../../common/pagination';
import { ZQuery } from '../../common/pipes/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';

const auditQuery = listQuerySchema.extend({ action: z.string().max(80).optional() });

/** Organization audit trail (admins, or supervisors granted audit:read). */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('audit:read')
  async list(@Ctx() ctx: RequestContext, @ZQuery(auditQuery) q: z.output<typeof auditQuery>) {
    const where = { tenantId: ctx.tenantId, ...(q.action ? { action: { startsWith: q.action } } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.system.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q.page, q.pageSize) }),
      this.prisma.system.auditLog.count({ where }),
    ]);
    const actorIds = [...new Set(items.map((i) => i.actorUserId).filter((x): x is string => !!x))];
    const users = await this.prisma.system.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
    const names = new Map(users.map((u) => [u.id, u.name]));
    return toPage(
      items.map((i) => ({ ...i, actor: i.actorUserId ? (names.get(i.actorUserId) ?? null) : 'System' })),
      total,
      q.page,
      q.pageSize,
    );
  }
}

@Module({ controllers: [AuditController] })
export class AuditHttpModule {}
