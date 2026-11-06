import { Injectable } from '@nestjs/common';
import type { callListQuerySchema } from '@crm/shared';
import { maskPhone } from '@crm/shared/phone';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ScopeService } from '../org/org-core.service';

@Injectable()
export class CallsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  private async names(tenantId: string, ids: string[]) {
    const rows = await this.prisma.db.membership.findMany({ where: { tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, user: { select: { name: true } } } });
    return new Map(rows.map((r) => [r.id, r.user.name]));
  }

  async list(ctx: RequestContext, q: z.output<typeof callListQuerySchema>) {
    const scoped = await this.scope.callWhere(ctx);
    const filters: Prisma.CallWhereInput = {
      tenantId: ctx.tenantId,
      ...(q.membershipId ? { membershipId: q.membershipId } : {}),
      ...(q.leadId ? { leadId: q.leadId } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.from || q.to ? { initiatedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
    };
    const where: Prisma.CallWhereInput = { tenantId: ctx.tenantId, AND: [scoped, filters] };
    const [rows, total] = await Promise.all([
      this.prisma.db.call.findMany({
        where,
        orderBy: { initiatedAt: 'desc' },
        ...pageArgs(q.page, q.pageSize),
        include: {
          lead: { select: { id: true, fullName: true, phoneE164: true } },
          outcome: { select: { outcomeCode: true, outcomeLabel: true, category: true } },
          recordings: { where: { tenantId: ctx.tenantId, status: 'AVAILABLE' }, select: { id: true, durationSeconds: true } },
        },
      }),
      this.prisma.db.call.count({ where }),
    ]);
    const names = await this.names(ctx.tenantId, rows.map((r) => r.membershipId));
    return toPage(
      rows.map((c) => ({
        id: c.id,
        status: c.status,
        isSimulated: c.isSimulated,
        provider: c.provider,
        initiatedAt: c.initiatedAt,
        customerAnsweredAt: c.customerAnsweredAt,
        endedAt: c.endedAt,
        talkSeconds: c.talkSeconds,
        billableSeconds: c.billableSeconds,
        costMicros: c.costMicros,
        costCurrency: c.costCurrency,
        costSource: c.costSource,
        failureReason: c.failureReason,
        wrapUpStatus: c.wrapUpStatus,
        attemptNumber: c.attemptNumber,
        agent: { id: c.membershipId, name: names.get(c.membershipId) ?? null },
        lead: { id: c.lead.id, fullName: c.lead.fullName, phone: ctx.role === 'AGENT' ? maskPhone(c.lead.phoneE164) : c.lead.phoneE164 },
        outcome: c.outcome,
        recordings: c.recordings,
      })),
      total,
      q.page,
      q.pageSize,
    );
  }

  async detail(ctx: RequestContext, id: string) {
    const scoped = await this.scope.callWhere(ctx);
    const call = await this.prisma.db.call.findFirst({
      where: { tenantId: ctx.tenantId, AND: [scoped, { id, tenantId: ctx.tenantId }] },
      include: {
        lead: true,
        legs: { orderBy: { createdAt: 'asc' } },
        outcome: true,
        recordings: { where: { tenantId: ctx.tenantId }, select: { id: true, status: true, durationSeconds: true, createdAt: true, retentionUntil: true } },
      },
    });
    if (!call) throw Errors.notFound('Call');
    const names = await this.names(ctx.tenantId, [call.membershipId, ...call.legs.map((l) => l.supervisorMembershipId).filter((x): x is string => !!x)]);
    const masked = ctx.role === 'AGENT';
    return {
      ...call,
      toNumberE164: masked ? maskPhone(call.toNumberE164) : call.toNumberE164,
      idempotencyKey: undefined,
      agent: { id: call.membershipId, name: names.get(call.membershipId) ?? null },
      lead: { id: call.lead.id, fullName: call.lead.fullName, phone: masked ? maskPhone(call.lead.phoneE164) : call.lead.phoneE164, status: call.lead.status },
      legs: call.legs.map((l) => ({
        id: l.id,
        role: l.role,
        status: l.status,
        toAddress: masked || l.role === 'AGENT' ? undefined : l.toAddress,
        providerCallId: masked ? undefined : l.providerCallId,
        initiatedAt: l.initiatedAt,
        ringingAt: l.ringingAt,
        answeredAt: l.answeredAt,
        endedAt: l.endedAt,
        durationSeconds: l.durationSeconds,
        billSeconds: l.billSeconds,
        costMicros: l.costMicros,
        costCurrency: l.costCurrency,
        costSource: l.costSource,
        hangupCause: l.hangupCause,
        hangupSource: l.hangupSource,
        coachMode: l.coachMode,
        supervisor: l.supervisorMembershipId ? (names.get(l.supervisorMembershipId) ?? null) : null,
      })),
    };
  }

  async events(ctx: RequestContext, id: string) {
    const scoped = await this.scope.callWhere(ctx);
    const call = await this.prisma.db.call.findFirst({ where: { tenantId: ctx.tenantId, AND: [scoped, { id, tenantId: ctx.tenantId }] }, select: { id: true } });
    if (!call) throw Errors.notFound('Call');
    return this.prisma.db.callEvent.findMany({
      where: { tenantId: ctx.tenantId, callId: id },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, type: true, source: true, dedupeKey: true, signatureValid: true, occurredAt: true, receivedAt: true, processedAt: true, processingError: true, payload: true },
    });
  }
}
