import { Global, Injectable, Module } from '@nestjs/common';
import {
  OPERATIONAL_SUBSCRIPTION_STATUSES,
  parseTenantSettings,
  scopeFor,
  type SubscriptionStatus,
  type TenantSettings,
} from '@crm/shared';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';

export interface PlanFeatures {
  recording: boolean;
  whatsapp: boolean;
  coaching: boolean;
  advancedReports: boolean;
}

/** Tenant settings access (validated against the shared schema on every read). */
@Injectable()
export class TenantSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string, tx?: Tx): Promise<{ settings: TenantSettings; timezone: string; name: string }> {
    const tenant = await (tx ?? this.prisma.system).tenant.findUnique({ where: { id: tenantId }, select: { settings: true, timezone: true, name: true } });
    if (!tenant) throw Errors.notFound('Organization');
    return { settings: parseTenantSettings(tenant.settings), timezone: tenant.timezone, name: tenant.name };
  }
}

/** Plan limits and subscription state. Enforced server-side before operations that cost money. */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async subscription(tenantId: string, tx?: Tx) {
    const sub = await (tx ?? this.prisma.db).subscription.findFirst({ where: { tenantId }, include: { plan: true } });
    if (!sub) throw Errors.paymentRequired('No subscription is set up for this organization. Contact support.');
    return sub;
  }

  features(plan: { features: Prisma.JsonValue }): PlanFeatures {
    const f = (plan.features ?? {}) as Partial<PlanFeatures>;
    return { recording: !!f.recording, whatsapp: !!f.whatsapp, coaching: !!f.coaching, advancedReports: !!f.advancedReports };
  }

  isOperational(status: SubscriptionStatus): boolean {
    return OPERATIONAL_SUBSCRIPTION_STATUSES.includes(status);
  }

  async assertOperational(tenantId: string, tx?: Tx) {
    const sub = await this.subscription(tenantId, tx);
    if (!this.isOperational(sub.status as SubscriptionStatus)) {
      throw Errors.paymentRequired('Your subscription is not active, so calling, imports and invitations are paused. Contact your account manager.');
    }
    return sub;
  }

  async assertFeature(tenantId: string, feature: keyof PlanFeatures, label: string, tx?: Tx) {
    const sub = await this.assertOperational(tenantId, tx);
    if (!this.features(sub.plan)[feature]) throw Errors.featureUnavailable(`${label} is not included in the ${sub.plan.name} plan.`);
    return sub;
  }

  async assertAgentSeat(tenantId: string, tx?: Tx) {
    const sub = await this.assertOperational(tenantId, tx);
    const agents = await (tx ?? this.prisma.db).membership.count({ where: { tenantId, role: 'AGENT', status: 'ACTIVE' } });
    if (agents >= sub.plan.maxAgents) {
      throw Errors.conflict('AGENT_LIMIT_REACHED', `Your plan allows ${sub.plan.maxAgents} active agents.`);
    }
  }

  async importAllowance(tenantId: string): Promise<{ limit: number; used: number; remaining: number }> {
    const sub = await this.subscription(tenantId);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const used = await this.prisma.db.usageLedgerEntry.aggregate({
      where: { tenantId, kind: 'LEAD_IMPORT', occurredAt: { gte: monthStart } },
      _sum: { quantity: true },
    });
    const usedN = Number(used._sum.quantity ?? 0n);
    return { limit: sub.plan.maxLeadImportsPerMonth, used: usedN, remaining: Math.max(0, sub.plan.maxLeadImportsPerMonth - usedN) };
  }

  async assertConcurrentCallCapacity(tenantId: string, tx: Tx) {
    const sub = await this.assertOperational(tenantId, tx);
    const active = await tx.call.count({ where: { tenantId, status: { in: ['INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED'] } } });
    if (active >= sub.plan.maxConcurrentCalls) {
      throw Errors.conflict('CONCURRENCY_LIMIT', `Your plan allows ${sub.plan.maxConcurrentCalls} simultaneous calls. Try again shortly.`);
    }
  }
}

/** Row-level data scope per role: admins see everything, supervisors their teams, agents their own. */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Agent memberships in teams the supervisor supervises (always includes the supervisor). */
  async teamMembershipIds(ctx: RequestContext): Promise<string[]> {
    const teams = await this.prisma.db.teamSupervisor.findMany({ where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId }, select: { teamId: true } });
    if (teams.length === 0) return [ctx.membershipId];
    const members = await this.prisma.db.membership.findMany({
      where: { tenantId: ctx.tenantId, teamId: { in: teams.map((t) => t.teamId) } },
      select: { id: true },
    });
    return [ctx.membershipId, ...members.map((m) => m.id)];
  }

  async leadWhere(ctx: RequestContext): Promise<Prisma.LeadWhereInput> {
    const scope = scopeFor(ctx.permissions, 'leads');
    if (scope === 'all') return { tenantId: ctx.tenantId };
    if (scope === 'none') return { tenantId: ctx.tenantId, id: { in: [] } };
    const ids = scope === 'team' ? await this.teamMembershipIds(ctx) : [ctx.membershipId];
    return {
      tenantId: ctx.tenantId,
      OR: [{ assignedMembershipId: { in: ids } }, { calls: { some: { tenantId: ctx.tenantId, membershipId: { in: ids } } } }],
    };
  }

  async callWhere(ctx: RequestContext): Promise<Prisma.CallWhereInput> {
    const scope = scopeFor(ctx.permissions, 'calls');
    if (scope === 'all') return { tenantId: ctx.tenantId };
    if (scope === 'none') return { tenantId: ctx.tenantId, id: { in: [] } };
    const ids = scope === 'team' ? await this.teamMembershipIds(ctx) : [ctx.membershipId];
    return { tenantId: ctx.tenantId, membershipId: { in: ids } };
  }

  async callbackWhere(ctx: RequestContext): Promise<Prisma.CallbackWhereInput> {
    const scope = scopeFor(ctx.permissions, 'callbacks');
    if (scope === 'all') return { tenantId: ctx.tenantId };
    if (scope === 'none') return { tenantId: ctx.tenantId, id: { in: [] } };
    const ids = scope === 'team' ? await this.teamMembershipIds(ctx) : [ctx.membershipId];
    return { tenantId: ctx.tenantId, assignedMembershipId: { in: ids } };
  }

  /** Membership ids whose agent activity the caller may see. Null means all. */
  async visibleAgentIds(ctx: RequestContext): Promise<string[] | null> {
    const scope = scopeFor(ctx.permissions, 'calls');
    if (scope === 'all') return null;
    if (scope === 'team') return this.teamMembershipIds(ctx);
    return [ctx.membershipId];
  }
}

@Global()
@Module({ providers: [TenantSettingsService, EntitlementsService, ScopeService], exports: [TenantSettingsService, EntitlementsService, ScopeService] })
export class OrgCoreModule {}
