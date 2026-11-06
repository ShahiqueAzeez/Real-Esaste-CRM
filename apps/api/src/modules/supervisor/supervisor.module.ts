import { Controller, Get, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ACTIVE_CALL_STATUSES, monitorSchema, RealtimeEvent, type ExpectIncomingPayload, type MonitorMode } from '@crm/shared';
import type { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { UuidParam, ZBody } from '../../common/pipes/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RealtimeService } from '../../infra/realtime/realtime.service';
import { AuditService } from '../audit/audit.service';
import { CallLifecycleService } from '../calls/call-lifecycle.service';
import { QueuesService } from '../queues/queues.service';
import { EntitlementsService, ScopeService } from '../org/org-core.service';
import { PlivoProvider } from '../telephony/plivo.provider';
import { TelephonyRegistry } from '../telephony/registry.service';

@Injectable()
export class SupervisorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly queues: QueuesService,
    private readonly registry: TelephonyRegistry,
    private readonly entitlements: EntitlementsService,
    private readonly realtime: RealtimeService,
    private readonly lifecycle: CallLifecycleService,
    private readonly audit: AuditService,
  ) {}

  /** Live board: agent availability, active calls, queue health, overdue callbacks. */
  async board(ctx: RequestContext) {
    const visible = await this.scope.visibleAgentIds(ctx);
    const agentFilter = visible ? { id: { in: visible } } : {};
    const since = new Date(Date.now() - 24 * 3600_000);
    const [agents, activeCalls, queueCounts, overdue, todayStats] = await Promise.all([
      this.prisma.db.membership.findMany({
        where: { tenantId: ctx.tenantId, role: 'AGENT', status: 'ACTIVE', ...agentFilter },
        include: { user: { select: { name: true } }, agentState: true, team: { select: { name: true } } },
        orderBy: { user: { name: 'asc' } },
      }),
      this.prisma.db.call.findMany({
        where: { tenantId: ctx.tenantId, status: { in: ACTIVE_CALL_STATUSES }, ...(visible ? { membershipId: { in: visible } } : {}) },
        include: { lead: { select: { fullName: true } }, legs: { select: { role: true, status: true, coachMode: true, supervisorMembershipId: true } } },
        orderBy: { initiatedAt: 'asc' },
      }),
      this.queues.list(ctx),
      this.prisma.db.callback.count({ where: { tenantId: ctx.tenantId, status: 'PENDING', dueAt: { lt: new Date() }, ...(visible ? { assignedMembershipId: { in: visible } } : {}) } }),
      this.prisma.db.call.groupBy({
        by: ['membershipId'],
        where: { tenantId: ctx.tenantId, initiatedAt: { gte: since }, ...(visible ? { membershipId: { in: visible } } : {}) },
        _count: { _all: true },
        _sum: { talkSeconds: true },
      }),
    ]);
    const stats = new Map(todayStats.map((s) => [s.membershipId, { calls: s._count._all, talkSeconds: s._sum.talkSeconds ?? 0 }]));
    const names = new Map(agents.map((a) => [a.id, a.user.name]));
    const { provider } = await this.registry.resolve(ctx.tenantId);
    const sub = await this.entitlements.subscription(ctx.tenantId);
    return {
      coaching: {
        available: !!provider?.capabilities.coaching && this.entitlements.features(sub.plan).coaching,
        reason: !provider?.capabilities.coaching
          ? 'Live coaching needs the Plivo provider (MultiPartyCall coach mode). Simulated calls carry no audio.'
          : !this.entitlements.features(sub.plan).coaching
            ? `Coaching is not included in the ${sub.plan.name} plan.`
            : null,
      },
      agents: agents.map((a) => ({
        membershipId: a.id,
        name: a.user.name,
        team: a.team?.name ?? null,
        status: a.agentState?.status ?? 'OFFLINE',
        pauseReason: a.agentState?.pauseReason ?? null,
        statusChangedAt: a.agentState?.statusChangedAt ?? null,
        currentCallId: a.agentState?.currentCallId ?? null,
        last24h: stats.get(a.id) ?? { calls: 0, talkSeconds: 0 },
      })),
      activeCalls: activeCalls.map((c) => ({
        id: c.id,
        status: c.status,
        isSimulated: c.isSimulated,
        agentId: c.membershipId,
        agent: names.get(c.membershipId) ?? null,
        lead: c.lead.fullName,
        initiatedAt: c.initiatedAt,
        customerAnsweredAt: c.customerAnsweredAt,
        monitoring: c.legs.filter((l) => l.role === 'SUPERVISOR' && !['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'].includes(l.status)).map((l) => ({ supervisorId: l.supervisorMembershipId, coachMode: l.coachMode })),
      })),
      queues: queueCounts,
      overdueCallbacks: overdue,
    };
  }

  private async callInScope(ctx: RequestContext, callId: string) {
    const where = await this.scope.callWhere(ctx);
    const call = await this.prisma.db.call.findFirst({ where: { tenantId: ctx.tenantId, AND: [where, { id: callId, tenantId: ctx.tenantId }] }, include: { legs: true } });
    if (!call) throw Errors.notFound('Call');
    return call;
  }

  /**
   * Join a live call as a supervisor. WHISPER uses Plivo MPC coach mode (heard by the agent only);
   * BARGE joins as a normal participant. Requires the supervisor's browser to be registered.
   */
  async monitor(ctx: RequestContext, callId: string, mode: MonitorMode) {
    await this.entitlements.assertFeature(ctx.tenantId, 'coaching', 'Live coaching');
    const call = await this.callInScope(ctx, callId);
    if (call.status !== 'CONNECTED') throw Errors.conflict('CALL_NOT_LIVE', 'You can only join a connected call');
    if (call.legs.some((l) => l.role === 'SUPERVISOR' && l.supervisorMembershipId === ctx.membershipId && !['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'].includes(l.status))) {
      throw Errors.conflict('ALREADY_MONITORING', 'You are already on this call');
    }
    const provider = await this.registry.forCall(ctx.tenantId, call.provider);
    if (!provider.capabilities.coaching) throw Errors.featureUnavailable('Live coaching needs the Plivo provider.');
    const membership = await this.prisma.db.membership.findFirstOrThrow({ where: { id: ctx.membershipId, tenantId: ctx.tenantId } });
    const target = provider.browserTarget(membership.telephonyIdentity);
    const leg = await this.prisma.db.callLeg.create({
      data: { tenantId: ctx.tenantId, callId, role: 'SUPERVISOR', provider: call.provider, toAddress: target.address, fromNumber: call.fromNumber, supervisorMembershipId: ctx.membershipId, coachMode: mode === 'WHISPER', status: 'QUEUED' },
    });
    const expect: ExpectIncomingPayload = { callId, purpose: 'MONITOR', expiresAt: new Date(Date.now() + 45_000).toISOString() };
    await this.realtime.toMembership(ctx.membershipId, RealtimeEvent.EXPECT_INCOMING, expect);
    try {
      const res = await provider.addSupervisor({ tenantId: ctx.tenantId, callId, legId: leg.id, mpcName: PlivoProvider.mpcName(callId), from: call.fromNumber!, to: target, coach: mode === 'WHISPER' });
      await this.prisma.db.callLeg.update({ where: { id: leg.id, tenantId: ctx.tenantId }, data: { providerRequestId: res.providerRequestId, status: 'INITIATED', initiatedAt: new Date() } });
    } catch (err) {
      await this.lifecycle.systemEndLeg(call, leg.id, 'FAILED', `provider_error: ${(err as Error).message}`.slice(0, 300));
      throw Errors.unavailable('PROVIDER_ERROR', `Could not join the call: ${(err as Error).message}`);
    }
    await this.audit.fromCtx(ctx, 'monitor.started', 'call', callId, { mode, agentMembershipId: call.membershipId });
    return { legId: leg.id, mode };
  }

  async setMode(ctx: RequestContext, callId: string, mode: MonitorMode) {
    const call = await this.callInScope(ctx, callId);
    const leg = call.legs.find((l) => l.role === 'SUPERVISOR' && l.supervisorMembershipId === ctx.membershipId && l.status === 'ANSWERED');
    if (!leg?.providerCallId) throw Errors.conflict('NOT_MONITORING', 'Answer the monitoring call in your browser first');
    const provider = await this.registry.forCall(ctx.tenantId, call.provider);
    await provider.setSupervisorMode({ mpcName: PlivoProvider.mpcName(callId), participantCallId: leg.providerCallId, coach: mode === 'WHISPER' });
    await this.prisma.db.callLeg.update({ where: { id: leg.id, tenantId: ctx.tenantId }, data: { coachMode: mode === 'WHISPER' } });
    await this.audit.fromCtx(ctx, 'monitor.mode_changed', 'call', callId, { mode });
    return { mode };
  }

  async stop(ctx: RequestContext, callId: string) {
    const call = await this.callInScope(ctx, callId);
    const provider = await this.registry.forCall(ctx.tenantId, call.provider);
    for (const leg of call.legs.filter((l) => l.role === 'SUPERVISOR' && l.supervisorMembershipId === ctx.membershipId && !['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'].includes(l.status))) {
      await provider.hangupLeg({ providerCallId: leg.providerCallId, providerRequestId: leg.providerRequestId, legId: leg.id, callId, tenantId: ctx.tenantId, answered: leg.everAnswered }).catch(() => undefined);
    }
    await this.audit.fromCtx(ctx, 'monitor.stopped', 'call', callId);
  }
}

@ApiTags('supervisor')
@Controller('supervisor')
export class SupervisorController {
  constructor(private readonly supervisor: SupervisorService) {}

  @Get('board')
  @RequirePermissions('monitor:view')
  board(@Ctx() ctx: RequestContext) {
    return this.supervisor.board(ctx);
  }

  @Post('calls/:id/monitor')
  @RequirePermissions('monitor:coach')
  @HttpCode(200)
  monitor(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(monitorSchema) body: z.output<typeof monitorSchema>) {
    return this.supervisor.monitor(ctx, id, body.mode);
  }

  @Post('calls/:id/monitor/mode')
  @RequirePermissions('monitor:coach')
  @HttpCode(200)
  mode(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(monitorSchema) body: z.output<typeof monitorSchema>) {
    return this.supervisor.setMode(ctx, id, body.mode);
  }

  @Post('calls/:id/monitor/stop')
  @RequirePermissions('monitor:coach')
  @HttpCode(204)
  stop(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.supervisor.stop(ctx, id);
  }
}

@Module({ controllers: [SupervisorController], providers: [SupervisorService] })
export class SupervisorModule {}
