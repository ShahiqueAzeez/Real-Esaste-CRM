import { Controller, Get, Global, Injectable, Module, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { callbackCreateSchema, callbackUpdateSchema, listQuerySchema, RealtimeEvent } from '@crm/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { UuidParam, ZBody, ZQuery } from '../../common/pipes/zod';
import { JobsService } from '../../infra/jobs/jobs.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RealtimeService } from '../../infra/realtime/realtime.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService, TenantSettingsService } from '../org/org-core.service';

const callbackListQuery = listQuerySchema.extend({
  status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED', 'MISSED']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  membershipId: z.uuid().optional(),
});

@Injectable()
export class CallbacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly settings: TenantSettingsService,
    private readonly jobs: JobsService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: RequestContext, q: z.output<typeof callbackListQuery>) {
    const scoped = await this.scope.callbackWhere(ctx);
    const now = new Date();
    const where: Prisma.CallbackWhereInput = {
      tenantId: ctx.tenantId,
      AND: [
        scoped,
        {
          tenantId: ctx.tenantId,
          ...(q.status ? { status: q.status } : {}),
          ...(q.overdue === 'true' ? { status: 'PENDING', dueAt: { lt: now } } : {}),
          ...(q.membershipId ? { assignedMembershipId: q.membershipId } : {}),
        },
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.callback.findMany({ where, orderBy: { dueAt: 'asc' }, ...pageArgs(q.page, q.pageSize), include: { lead: { select: { id: true, fullName: true, status: true } } } }),
      this.prisma.db.callback.count({ where }),
    ]);
    const ids = [...new Set(rows.map((r) => r.assignedMembershipId).filter((x): x is string => !!x))];
    const members = await this.prisma.db.membership.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, user: { select: { name: true } } } });
    const names = new Map(members.map((m) => [m.id, m.user.name]));
    return toPage(
      rows.map((r) => ({ ...r, overdue: r.status === 'PENDING' && r.dueAt < now, assignee: r.assignedMembershipId ? (names.get(r.assignedMembershipId) ?? null) : null })),
      total,
      q.page,
      q.pageSize,
    );
  }

  async summary(ctx: RequestContext) {
    const scoped = await this.scope.callbackWhere(ctx);
    const now = new Date();
    const soon = new Date(now.getTime() + 3600_000);
    const base = (extra: Prisma.CallbackWhereInput): Prisma.CallbackWhereInput => ({ tenantId: ctx.tenantId, AND: [scoped, { tenantId: ctx.tenantId, ...extra }] });
    const [overdue, dueSoon, pending] = await Promise.all([
      this.prisma.db.callback.count({ where: base({ status: 'PENDING', dueAt: { lt: now } }) }),
      this.prisma.db.callback.count({ where: base({ status: 'PENDING', dueAt: { gte: now, lt: soon } }) }),
      this.prisma.db.callback.count({ where: base({ status: 'PENDING' }) }),
    ]);
    return { overdue, dueSoon, pending };
  }

  /** Schedule a callback outside a call (e.g. a lead asked by email). Puts the lead in the queue at that time. */
  async create(ctx: RequestContext, body: z.output<typeof callbackCreateSchema>) {
    const leadWhere = await this.scope.leadWhere(ctx);
    const lead = await this.prisma.db.lead.findFirst({ where: { AND: [leadWhere, { id: body.leadId, tenantId: ctx.tenantId }], tenantId: ctx.tenantId }, include: { queueItem: true } });
    if (!lead) throw Errors.notFound('Lead');
    if (body.dueAt.getTime() < Date.now()) throw Errors.validation([{ path: 'dueAt', message: 'Choose a time in the future' }]);
    const assignee = body.assignedMembershipId ?? (ctx.role === 'AGENT' ? ctx.membershipId : lead.assignedMembershipId);
    if (assignee) {
      const ok = await this.prisma.db.membership.findFirst({ where: { id: assignee, tenantId: ctx.tenantId, role: 'AGENT', status: 'ACTIVE' } });
      if (!ok) throw Errors.badRequest('INVALID_ASSIGNEE', 'Callbacks can only be assigned to active agents');
    }
    const cb = await this.prisma.db.$transaction(async (tx) => {
      const created = await tx.callback.create({ data: { tenantId: ctx.tenantId, leadId: lead.id, assignedMembershipId: assignee, createdByMembershipId: ctx.membershipId, dueAt: body.dueAt, notes: body.notes } });
      if (lead.queueItem && lead.queueItem.state !== 'IN_PROGRESS') {
        await tx.queueItem.update({
          where: { id: lead.queueItem.id, tenantId: ctx.tenantId },
          data: { state: lead.queueItem.state === 'DONE' && lead.queueItem.doneReason?.startsWith('SUPPRESSED') ? 'DONE' : 'WAITING', availableAt: body.dueAt, isCallback: true, callbackId: created.id, assignedMembershipId: assignee, priority: Math.max(lead.queueItem.priority, 50) },
        });
      }
      await tx.lead.update({ where: { id: lead.id, tenantId: ctx.tenantId }, data: { nextCallbackAt: body.dueAt, status: lead.status === 'NEW' || lead.status === 'CONTACTED' ? 'CALLBACK' : lead.status } });
      await tx.leadActivity.create({ data: { tenantId: ctx.tenantId, leadId: lead.id, type: 'CALLBACK_SCHEDULED', actorMembershipId: ctx.membershipId, data: { dueAt: body.dueAt.toISOString(), callbackId: created.id } } });
      return created;
    });
    await this.jobs.add('callbacks.reminder', { tenantId: ctx.tenantId, callbackId: cb.id }, { jobId: `cb-remind-${cb.id}`, delay: Math.max(0, body.dueAt.getTime() - 10 * 60_000 - Date.now()), attempts: 3 });
    return cb;
  }

  async update(ctx: RequestContext, id: string, body: z.output<typeof callbackUpdateSchema>) {
    const scoped = await this.scope.callbackWhere(ctx);
    const cb = await this.prisma.db.callback.findFirst({ where: { tenantId: ctx.tenantId, AND: [scoped, { id, tenantId: ctx.tenantId }] } });
    if (!cb) throw Errors.notFound('Callback');
    if (cb.status !== 'PENDING') throw Errors.conflict('CALLBACK_CLOSED', 'This callback is already closed');
    const updated = await this.prisma.db.$transaction(async (tx) => {
      const row = await tx.callback.update({
        where: { id, tenantId: ctx.tenantId },
        data: { dueAt: body.dueAt, notes: body.notes, status: body.status, assignedMembershipId: body.assignedMembershipId, ...(body.status === 'COMPLETED' ? { completedAt: new Date() } : {}) },
      });
      const item = await tx.queueItem.findFirst({ where: { tenantId: ctx.tenantId, callbackId: id, state: 'WAITING' } });
      if (item) {
        if (body.status === 'CANCELLED' || body.status === 'COMPLETED') await tx.queueItem.update({ where: { id: item.id, tenantId: ctx.tenantId }, data: { isCallback: false, callbackId: null } });
        else await tx.queueItem.update({ where: { id: item.id, tenantId: ctx.tenantId }, data: { availableAt: body.dueAt ?? item.availableAt, assignedMembershipId: body.assignedMembershipId === undefined ? item.assignedMembershipId : body.assignedMembershipId } });
      }
      await tx.lead.update({ where: { id: cb.leadId, tenantId: ctx.tenantId }, data: { nextCallbackAt: body.status && body.status !== 'PENDING' ? null : (body.dueAt ?? cb.dueAt) } });
      return row;
    });
    if (body.dueAt) await this.jobs.add('callbacks.reminder', { tenantId: ctx.tenantId, callbackId: id }, { jobId: `cb-remind-${id}-${body.dueAt.getTime()}`, delay: Math.max(0, body.dueAt.getTime() - 10 * 60_000 - Date.now()), attempts: 3 });
    await this.audit.fromCtx(ctx, 'callback.updated', 'callback', id, { status: body.status ?? null });
    return updated;
  }

  /** Worker: remind the assignee shortly before a callback is due. */
  async remind(tenantId: string, callbackId: string): Promise<void> {
    const cb = await this.prisma.system.callback.findUnique({ where: { id: callbackId }, include: { lead: { select: { fullName: true } } } });
    if (!cb || cb.tenantId !== tenantId || cb.status !== 'PENDING' || !cb.assignedMembershipId) return;
    if (cb.dueAt.getTime() - Date.now() > 15 * 60_000) return; // rescheduled later; a newer reminder exists
    if (cb.reminderSentAt && cb.reminderSentAt > new Date(cb.dueAt.getTime() - 20 * 60_000)) return;
    const { timezone } = await this.settings.get(tenantId);
    const when = new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone: timezone }).format(cb.dueAt);
    const n = await this.prisma.system.notification.create({
      data: { tenantId, membershipId: cb.assignedMembershipId, type: 'CALLBACK_DUE', title: `Callback with ${cb.lead.fullName} at ${when}`, body: cb.notes?.slice(0, 200) ?? null, data: { callbackId, leadId: cb.leadId } },
    });
    await this.prisma.system.callback.update({ where: { id: callbackId }, data: { reminderSentAt: new Date() } });
    await this.realtime.toMembership(cb.assignedMembershipId, RealtimeEvent.NOTIFICATION, n);
  }
}

@ApiTags('callbacks')
@Controller('callbacks')
export class CallbacksController {
  constructor(private readonly callbacks: CallbacksService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @ZQuery(callbackListQuery) q: z.output<typeof callbackListQuery>) {
    return this.callbacks.list(ctx, q);
  }

  @Get('summary')
  summary(@Ctx() ctx: RequestContext) {
    return this.callbacks.summary(ctx);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @ZBody(callbackCreateSchema) body: z.output<typeof callbackCreateSchema>) {
    return this.callbacks.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermissions('callbacks:manage')
  update(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(callbackUpdateSchema) body: z.output<typeof callbackUpdateSchema>) {
    return this.callbacks.update(ctx, id, body);
  }
}

@Global()
@Module({ providers: [CallbacksService], exports: [CallbacksService] })
export class CallbacksCoreModule {}

@Module({ controllers: [CallbacksController] })
export class CallbacksModule {}
