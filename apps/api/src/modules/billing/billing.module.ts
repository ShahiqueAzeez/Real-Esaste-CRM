import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EntitlementsService } from '../org/org-core.service';

/** Tenant view of its subscription, limits, usage against limits, and the billing ledger. */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get()
  @RequirePermissions('billing:read')
  async summary(@Ctx() ctx: RequestContext) {
    const sub = await this.entitlements.subscription(ctx.tenantId);
    const [agents, allowance, activeCalls, ledger] = await Promise.all([
      this.prisma.db.membership.count({ where: { tenantId: ctx.tenantId, role: 'AGENT', status: 'ACTIVE' } }),
      this.entitlements.importAllowance(ctx.tenantId),
      this.prisma.db.call.count({ where: { tenantId: ctx.tenantId, status: { in: ['INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED'] } } }),
      this.prisma.db.billingLedgerEntry.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    const balanceMinor = ledger.reduce((s, e) => s + (e.type === 'CHARGE' ? Number(e.amountMinor) : e.type === 'ADJUSTMENT' ? Number(e.amountMinor) : -Number(e.amountMinor)), 0);
    return {
      subscription: {
        status: sub.status,
        operational: this.entitlements.isOperational(sub.status),
        billingPeriod: sub.billingPeriod,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        trialEndsAt: sub.trialEndsAt,
        graceDays: sub.graceDays,
        paymentMode: sub.paymentMode,
      },
      plan: {
        code: sub.plan.code,
        name: sub.plan.name,
        currency: sub.plan.currency,
        monthlyPriceMinor: sub.plan.monthlyPriceMinor,
        annualPriceMinor: sub.plan.annualPriceMinor,
        features: this.entitlements.features(sub.plan),
      },
      limits: {
        agents: { used: agents, limit: sub.plan.maxAgents },
        leadImportsThisMonth: { used: allowance.used, limit: allowance.limit },
        concurrentCalls: { used: activeCalls, limit: sub.plan.maxConcurrentCalls },
      },
      ledger,
      balanceMinor,
      paymentCollection: {
        configured: false,
        message: 'Online payment collection is not configured. Charges and payments are recorded by your account manager; telephony and WhatsApp usage is billed by those providers separately.',
      },
    };
  }
}

@Module({ controllers: [BillingController] })
export class BillingModule {}
