import { Injectable } from '@nestjs/common';
import type { agentStatusSchema, deviceReportSchema } from '@crm/shared';
import type { z } from 'zod';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EntitlementsService, TenantSettingsService } from '../org/org-core.service';
import { TelephonyRegistry } from '../telephony/registry.service';
import { AgentStateService } from './agent-state.service';

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentStateService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: TenantSettingsService,
    private readonly registry: TelephonyRegistry,
  ) {}

  async state(ctx: RequestContext) {
    const [state, membership, { settings }] = await Promise.all([
      this.prisma.db.agentState.findFirst({ where: { membershipId: ctx.membershipId, tenantId: ctx.tenantId } }),
      this.prisma.db.membership.findFirstOrThrow({ where: { id: ctx.membershipId, tenantId: ctx.tenantId } }),
      this.settings.get(ctx.tenantId),
    ]);
    const { provider, source } = await this.registry.resolve(ctx.tenantId);
    return {
      state,
      callingMode: membership.callingMode ?? settings.calling.defaultMode,
      telephony: {
        provider: provider?.kind ?? null,
        source,
        simulated: provider?.capabilities.simulated ?? false,
        browserCalling: provider?.capabilities.browserCalling ?? false,
        configured: !!provider,
      },
      agentPhoneConfigured: !!membership.agentPhoneE164,
    };
  }

  async setStatus(ctx: RequestContext, body: z.output<typeof agentStatusSchema>) {
    const transition = await this.prisma.db.$transaction(async (tx) => {
      const state = await this.agents.lock(tx, ctx.tenantId, ctx.membershipId);
      const current = state?.status ?? 'OFFLINE';
      if (current === 'DIALING' || current === 'ON_CALL') throw Errors.conflict('CALL_IN_PROGRESS', 'Finish the current call first');
      if (current === 'WRAP_UP') throw Errors.conflict('WRAP_UP_PENDING', 'Save the outcome of your last call first');
      if (body.status === 'READY') await this.entitlements.assertOperational(ctx.tenantId, tx);
      return this.agents.set(tx, { tenantId: ctx.tenantId, membershipId: ctx.membershipId, status: body.status, pauseReason: body.reason ?? null, currentCallId: null });
    });
    await this.agents.publish(transition);
    return transition;
  }

  async reportDevice(ctx: RequestContext, body: z.output<typeof deviceReportSchema>) {
    await this.prisma.db.agentState.updateMany({
      where: { membershipId: ctx.membershipId, tenantId: ctx.tenantId },
      data: { microphone: body.microphone, providerRegistered: body.providerRegistered, deviceCheckedAt: new Date(), lastHeartbeatAt: new Date() },
    });
    return { ok: true };
  }

  async heartbeat(tenantId: string, membershipId: string) {
    await this.prisma.db.agentState.updateMany({ where: { membershipId, tenantId }, data: { lastHeartbeatAt: new Date() } });
  }

  /** Today's personal numbers, computed from persisted calls in the tenant timezone. */
  async today(ctx: RequestContext) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const tzStart = await this.prisma.db.$queryRaw<{ start: Date }[]>`SELECT date_trunc('day', now() AT TIME ZONE ${ctx.timezone}) AT TIME ZONE ${ctx.timezone} AS start`;
    const since = tzStart[0]?.start ?? start;
    const where = { tenantId: ctx.tenantId, membershipId: ctx.membershipId, initiatedAt: { gte: since } };
    const [attempted, connected, talk, outcomes, callbacksDue] = await Promise.all([
      this.prisma.db.call.count({ where: { ...where, countedAsAttempt: true } }),
      this.prisma.db.call.count({ where: { ...where, customerAnsweredAt: { not: null } } }),
      this.prisma.db.call.aggregate({ where, _sum: { talkSeconds: true } }),
      this.prisma.db.callOutcome.groupBy({ by: ['outcomeLabel'], where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId, createdAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.db.callback.count({ where: { tenantId: ctx.tenantId, assignedMembershipId: ctx.membershipId, status: 'PENDING', dueAt: { lte: new Date(Date.now() + 3600_000) } } }),
    ]);
    return {
      since,
      attempted,
      connected,
      talkSeconds: talk._sum.talkSeconds ?? 0,
      outcomes: outcomes.map((o) => ({ label: o.outcomeLabel, count: o._count._all })),
      callbacksDueSoon: callbacksDue,
    };
  }
}
