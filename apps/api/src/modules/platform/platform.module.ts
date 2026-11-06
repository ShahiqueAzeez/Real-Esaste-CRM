import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, HttpCode, Injectable, Module, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createTenantSchema, ledgerEntrySchema, listQuerySchema, planSchema, subscriptionUpdateSchema, tenantStatusSchema, updateTenantSchema } from '@crm/shared';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { CurrentAuth, PlatformAdminOnly, type AuthState } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { UuidParam, ZBody, ZQuery } from '../../common/pipes/zod';
import { Q } from '../../infra/jobs/jobs.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SessionService } from '../auth/session.service';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { UsersModule } from '../users/users.controller';
import { UsersService } from '../users/users.service';

const recordPaymentSchema = z.object({
  amountMinor: z.coerce.number().int().min(1),
  reference: z.string().trim().max(120).optional(),
  periods: z.coerce.number().int().min(1).max(24).default(1),
  isSimulated: z.boolean().default(false),
});

/**
 * Platform (SaaS super-admin) operations. Deliberately exposes no tenant leads, calls or
 * recordings: only organization metadata, subscriptions, aggregate usage and system health.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ProvisioningService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @InjectQueue(Q.dialer) private readonly dialerQ: Queue,
    @InjectQueue(Q.callEvents) private readonly eventsQ: Queue,
    @InjectQueue(Q.imports) private readonly importsQ: Queue,
    @InjectQueue(Q.whatsapp) private readonly waQ: Queue,
    @InjectQueue(Q.maintenance) private readonly maintQ: Queue,
  ) {}

  async tenants(page: number, pageSize: number) {
    const [rows, total] = await Promise.all([
      this.prisma.system.tenant.findMany({ orderBy: { createdAt: 'desc' }, ...pageArgs(page, pageSize), include: { subscription: { include: { plan: true } } } }),
      this.prisma.system.tenant.count(),
    ]);
    const ids = rows.map((r) => r.id);
    const since = new Date(Date.now() - 30 * 86400_000);
    const [agents, leads, calls] = await Promise.all([
      this.prisma.system.membership.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, role: 'AGENT', status: 'ACTIVE' }, _count: { _all: true } }),
      this.prisma.system.lead.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids } }, _count: { _all: true } }),
      this.prisma.system.call.groupBy({ by: ['tenantId'], where: { tenantId: { in: ids }, initiatedAt: { gte: since }, countedAsAttempt: true }, _count: { _all: true } }),
    ]);
    const m = (arr: { tenantId: string; _count: { _all: number } }[]) => new Map(arr.map((a) => [a.tenantId, a._count._all]));
    const [a, l, c] = [m(agents), m(leads), m(calls)];
    return toPage(
      rows.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        timezone: t.timezone,
        createdAt: t.createdAt,
        subscription: t.subscription ? { status: t.subscription.status, plan: t.subscription.plan.name, currentPeriodEnd: t.subscription.currentPeriodEnd } : null,
        activeAgents: a.get(t.id) ?? 0,
        leads: l.get(t.id) ?? 0,
        callAttempts30d: c.get(t.id) ?? 0,
      })),
      total,
      page,
      pageSize,
    );
  }

  async createTenant(auth: AuthState, body: z.output<typeof createTenantSchema>) {
    const tenant = await this.provisioning.createTenant({ name: body.name, slug: body.slug, timezone: body.timezone, planCode: body.planCode, billingPeriod: body.billingPeriod, trialDays: body.trialDays });
    const invite = await this.users.createInvitation(tenant.id, tenant.name, body.adminEmail, 'ORG_ADMIN', null, null);
    await this.audit.log({ actorUserId: auth.user.id, action: 'platform.tenant_created', entityType: 'tenant', entityId: tenant.id, metadata: { slug: tenant.slug, plan: body.planCode } });
    return { tenant, adminInvitation: invite };
  }

  async tenant(id: string) {
    const t = await this.prisma.system.tenant.findUnique({ where: { id }, include: { subscription: { include: { plan: true } }, providerConfigs: { select: { provider: true, enabled: true, status: true, lastError: true, lastCheckedAt: true } } } });
    if (!t) throw Errors.notFound('Organization');
    const [members, ledger, usage] = await Promise.all([
      this.prisma.system.membership.groupBy({ by: ['role', 'status'], where: { tenantId: id }, _count: { _all: true } }),
      this.prisma.system.billingLedgerEntry.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.system.usageLedgerEntry.groupBy({ by: ['kind', 'isEstimate', 'currency'], where: { tenantId: id, occurredAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _sum: { quantity: true, amountMicros: true } }),
    ]);
    return {
      tenant: { id: t.id, name: t.name, slug: t.slug, status: t.status, suspendedReason: t.suspendedReason, timezone: t.timezone, createdAt: t.createdAt },
      subscription: t.subscription,
      integrations: t.providerConfigs,
      members: members.map((g) => ({ role: g.role, status: g.status, count: g._count._all })),
      ledger,
      usage30d: usage.map((u) => ({ kind: u.kind, isEstimate: u.isEstimate, currency: u.currency, quantity: u._sum.quantity, amountMicros: u._sum.amountMicros })),
    };
  }

  async updateTenant(auth: AuthState, id: string, body: z.output<typeof updateTenantSchema>) {
    const t = await this.prisma.system.tenant.update({ where: { id }, data: body });
    await this.audit.log({ actorUserId: auth.user.id, action: 'platform.tenant_updated', entityType: 'tenant', entityId: id, metadata: body });
    return t;
  }

  async setStatus(auth: AuthState, id: string, body: z.output<typeof tenantStatusSchema>) {
    const t = await this.prisma.system.tenant.update({ where: { id }, data: { status: body.status, suspendedReason: body.status === 'SUSPENDED' ? (body.reason ?? 'Suspended by platform') : null } });
    if (body.status === 'SUSPENDED') {
      // Agents stop dialling immediately; sessions remain but tenant routes are refused.
      await this.prisma.system.agentState.updateMany({ where: { tenantId: id, status: { in: ['READY', 'PAUSED'] } }, data: { status: 'OFFLINE', pauseReason: 'Organization suspended' } });
    }
    await this.audit.log({ tenantId: id, actorUserId: auth.user.id, action: body.status === 'SUSPENDED' ? 'platform.tenant_suspended' : 'platform.tenant_reactivated', entityType: 'tenant', entityId: id, metadata: { reason: body.reason ?? null } });
    return t;
  }

  async updateSubscription(auth: AuthState, tenantId: string, body: z.output<typeof subscriptionUpdateSchema>) {
    const sub = await this.prisma.system.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw Errors.notFound('Subscription');
    let planId: string | undefined;
    if (body.planCode) {
      const plan = await this.prisma.system.plan.findUnique({ where: { code: body.planCode } });
      if (!plan) throw Errors.badRequest('PLAN_NOT_FOUND', 'Unknown plan');
      planId = plan.id;
    }
    const updated = await this.prisma.system.subscription.update({
      where: { tenantId },
      data: { planId, billingPeriod: body.billingPeriod, status: body.status, currentPeriodEnd: body.currentPeriodEnd, graceDays: body.graceDays },
      include: { plan: true },
    });
    await this.audit.log({ tenantId, actorUserId: auth.user.id, action: 'platform.subscription_updated', entityType: 'subscription', entityId: sub.id, metadata: JSON.parse(JSON.stringify(body)) });
    return updated;
  }

  async addLedger(auth: AuthState, tenantId: string, body: z.output<typeof ledgerEntrySchema>) {
    const sub = await this.prisma.system.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (!sub) throw Errors.notFound('Subscription');
    const entry = await this.prisma.system.billingLedgerEntry.create({
      data: { tenantId, type: body.type, amountMinor: BigInt(body.amountMinor), currency: sub.plan.currency, description: body.description, reference: body.reference ?? null, isSimulated: body.isSimulated, createdByUserId: auth.user.id },
    });
    await this.audit.log({ tenantId, actorUserId: auth.user.id, action: 'platform.ledger_entry', entityType: 'ledger', entityId: entry.id, metadata: { type: body.type, simulated: body.isSimulated } });
    return entry;
  }

  /** Record a manual (or clearly simulated) payment and extend the paid period. */
  async recordPayment(auth: AuthState, tenantId: string, body: z.output<typeof recordPaymentSchema>) {
    const sub = await this.prisma.system.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (!sub) throw Errors.notFound('Subscription');
    const base = sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
    const end = new Date(base);
    end.setUTCMonth(end.getUTCMonth() + (sub.billingPeriod === 'ANNUAL' ? 12 : 1) * body.periods);
    const [entry] = await this.prisma.system.$transaction([
      this.prisma.system.billingLedgerEntry.create({
        data: {
          tenantId,
          type: 'PAYMENT',
          amountMinor: BigInt(body.amountMinor),
          currency: sub.plan.currency,
          description: `${body.isSimulated ? 'SIMULATED payment' : 'Payment received'} for ${body.periods} ${sub.billingPeriod === 'ANNUAL' ? 'year(s)' : 'month(s)'} of ${sub.plan.name}`,
          reference: body.reference ?? null,
          periodStart: base,
          periodEnd: end,
          isSimulated: body.isSimulated,
          createdByUserId: auth.user.id,
        },
      }),
      this.prisma.system.subscription.update({ where: { tenantId }, data: { status: 'ACTIVE', currentPeriodStart: base, currentPeriodEnd: end, trialEndsAt: null, paymentMode: body.isSimulated ? 'SIMULATED' : 'MANUAL' } }),
    ]);
    await this.audit.log({ tenantId, actorUserId: auth.user.id, action: 'platform.payment_recorded', entityType: 'ledger', entityId: entry.id, metadata: { amountMinor: body.amountMinor, simulated: body.isSimulated } });
    return { entry, currentPeriodEnd: end };
  }

  plans() {
    return this.prisma.system.plan.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async savePlan(auth: AuthState, body: z.output<typeof planSchema>, id?: string) {
    const data = { ...body, monthlyPriceMinor: BigInt(body.monthlyPriceMinor), annualPriceMinor: BigInt(body.annualPriceMinor) };
    const plan = id ? await this.prisma.system.plan.update({ where: { id }, data }) : await this.prisma.system.plan.create({ data });
    await this.audit.log({ actorUserId: auth.user.id, action: id ? 'platform.plan_updated' : 'platform.plan_created', entityType: 'plan', entityId: plan.id });
    return plan;
  }

  async health() {
    const queues = { dialer: this.dialerQ, 'call-events': this.eventsQ, imports: this.importsQ, whatsapp: this.waQ, maintenance: this.maintQ };
    const counts = Object.fromEntries(
      await Promise.all(Object.entries(queues).map(async ([name, q]) => [name, await q.getJobCounts('waiting', 'active', 'delayed', 'failed')] as const)),
    );
    const [db, unprocessed, failures, stuckCalls] = await Promise.all([
      this.prisma.ping(),
      this.prisma.system.callEvent.count({ where: { processedAt: null, receivedAt: { lt: new Date(Date.now() - 60_000) } } }),
      this.prisma.system.providerConfig.findMany({ where: { lastError: { not: null } }, select: { provider: true, lastError: true, lastCheckedAt: true, updatedAt: true, tenant: { select: { id: true, name: true } } }, orderBy: { updatedAt: 'desc' }, take: 50 }),
      this.prisma.system.call.count({ where: { status: { in: ['INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING'] }, initiatedAt: { lt: new Date(Date.now() - 10 * 60_000) } } }),
    ]);
    return { database: db ? 'ok' : 'down', queues: counts, unprocessedCallEvents: unprocessed, stuckCalls, integrationFailures: failures };
  }

  async auditLog(page: number, pageSize: number) {
    const where = { action: { startsWith: 'platform.' } };
    const [items, total] = await Promise.all([
      this.prisma.system.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(page, pageSize) }),
      this.prisma.system.auditLog.count({ where }),
    ]);
    return toPage(items, total, page, pageSize);
  }
}

@ApiTags('platform')
@PlatformAdminOnly()
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('tenants')
  tenants(@ZQuery(listQuerySchema) q: z.output<typeof listQuerySchema>) {
    return this.platform.tenants(q.page, q.pageSize);
  }

  @Post('tenants')
  create(@CurrentAuth() auth: AuthState, @ZBody(createTenantSchema) body: z.output<typeof createTenantSchema>) {
    return this.platform.createTenant(auth, body);
  }

  @Get('tenants/:id')
  tenant(@UuidParam('id') id: string) {
    return this.platform.tenant(id);
  }

  @Patch('tenants/:id')
  update(@CurrentAuth() auth: AuthState, @UuidParam('id') id: string, @ZBody(updateTenantSchema) body: z.output<typeof updateTenantSchema>) {
    return this.platform.updateTenant(auth, id, body);
  }

  @Post('tenants/:id/status')
  @HttpCode(200)
  status(@CurrentAuth() auth: AuthState, @UuidParam('id') id: string, @ZBody(tenantStatusSchema) body: z.output<typeof tenantStatusSchema>) {
    return this.platform.setStatus(auth, id, body);
  }

  @Patch('tenants/:id/subscription')
  subscription(@CurrentAuth() auth: AuthState, @UuidParam('id') id: string, @ZBody(subscriptionUpdateSchema) body: z.output<typeof subscriptionUpdateSchema>) {
    return this.platform.updateSubscription(auth, id, body);
  }

  @Post('tenants/:id/ledger')
  ledger(@CurrentAuth() auth: AuthState, @UuidParam('id') id: string, @ZBody(ledgerEntrySchema) body: z.output<typeof ledgerEntrySchema>) {
    return this.platform.addLedger(auth, id, body);
  }

  @Post('tenants/:id/payments')
  payment(@CurrentAuth() auth: AuthState, @UuidParam('id') id: string, @ZBody(recordPaymentSchema) body: z.output<typeof recordPaymentSchema>) {
    return this.platform.recordPayment(auth, id, body);
  }

  @Get('plans')
  plans() {
    return this.platform.plans();
  }

  @Post('plans')
  createPlan(@CurrentAuth() auth: AuthState, @ZBody(planSchema) body: z.output<typeof planSchema>) {
    return this.platform.savePlan(auth, body);
  }

  @Patch('plans/:id')
  updatePlan(@CurrentAuth() auth: AuthState, @UuidParam('id') id: string, @ZBody(planSchema) body: z.output<typeof planSchema>) {
    return this.platform.savePlan(auth, body, id);
  }

  @Get('health')
  health() {
    return this.platform.health();
  }

  @Get('audit')
  audit(@ZQuery(listQuerySchema) q: z.output<typeof listQuerySchema>) {
    return this.platform.auditLog(q.page, q.pageSize);
  }
}

@Module({ imports: [UsersModule], controllers: [PlatformController], providers: [PlatformService] })
export class PlatformModule {}
