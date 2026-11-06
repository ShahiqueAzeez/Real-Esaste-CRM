import { Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, type RequestContext } from '../../common/auth-context';
import { UuidParam } from '../../common/pipes/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const [items, unread] = await Promise.all([
      this.prisma.db.notification.findMany({ where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId }, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.db.notification.count({ where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId, readAt: null } }),
    ]);
    return { items, unread };
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    await this.prisma.db.notification.updateMany({ where: { id, tenantId: ctx.tenantId, membershipId: ctx.membershipId }, data: { readAt: new Date() } });
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@Ctx() ctx: RequestContext) {
    await this.prisma.db.notification.updateMany({ where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId, readAt: null }, data: { readAt: new Date() } });
  }
}

@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
