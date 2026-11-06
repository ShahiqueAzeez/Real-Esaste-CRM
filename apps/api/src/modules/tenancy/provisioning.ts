import { DEFAULT_OUTCOMES, DEFAULT_TENANT_SETTINGS, SYSTEM_OUTCOME_CODES, type MembershipRole } from '@crm/shared';
import type { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

/**
 * Plain provisioning functions (no Nest DI) shared by ProvisioningService, the seed script and the
 * bootstrap CLI. Callers pass a transaction client.
 */
type Tx = Prisma.TransactionClient;

export class ProvisioningError extends Error {
  constructor(
    readonly code: 'PLAN_NOT_FOUND' | 'SLUG_TAKEN',
    message: string,
  ) {
    super(message);
  }
}

export function newTelephonyIdentity(): string {
  return `crm_${randomBytes(9).toString('hex')}`;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  timezone: string;
  planCode: string;
  billingPeriod: 'MONTHLY' | 'ANNUAL';
  trialDays: number;
  settings?: Record<string, unknown>;
}

export async function createTenantRecords(db: Tx, input: CreateTenantInput) {
  const plan = await db.plan.findUnique({ where: { code: input.planCode } });
  if (!plan || !plan.active) throw new ProvisioningError('PLAN_NOT_FOUND', 'Unknown or inactive plan');
  const existing = await db.tenant.findUnique({ where: { slug: input.slug } });
  if (existing) throw new ProvisioningError('SLUG_TAKEN', 'That organization slug is already in use');
  const now = new Date();
  const tenant = await db.tenant.create({
    data: { name: input.name, slug: input.slug, timezone: input.timezone, settings: (input.settings ?? DEFAULT_TENANT_SETTINGS) as object },
  });
  await db.outcomeDefinition.createMany({
    data: DEFAULT_OUTCOMES.map((o) => ({
      tenantId: tenant.id,
      code: o.code,
      label: o.label,
      category: o.category,
      leadStatus: o.leadStatus,
      requiresNotes: o.requiresNotes,
      requiresCallback: o.requiresCallback,
      retryBehavior: o.retryBehavior,
      suppressReason: o.suppressReason,
      isFinal: o.isFinal,
      selectable: o.selectable,
      isSystem: SYSTEM_OUTCOME_CODES.includes(o.code),
      sortOrder: o.sortOrder,
    })),
  });
  await db.queue.create({ data: { tenantId: tenant.id, name: 'Default', isDefault: true, description: 'Leads are added here unless another queue is chosen.' } });
  const trial = input.trialDays > 0;
  const periodEnd = new Date(now);
  if (trial) periodEnd.setUTCDate(periodEnd.getUTCDate() + input.trialDays);
  else periodEnd.setUTCMonth(periodEnd.getUTCMonth() + (input.billingPeriod === 'ANNUAL' ? 12 : 1));
  await db.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: trial ? 'TRIALING' : 'ACTIVE',
      billingPeriod: input.billingPeriod,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: trial ? periodEnd : null,
    },
  });
  return tenant;
}

/** Create (or reactivate) a membership plus its agent state and default-queue membership. */
export async function addMembershipRecords(db: Tx, input: { tenantId: string; userId: string; role: MembershipRole; teamId?: string | null }) {
  const existing = await db.membership.findFirst({ where: { tenantId: input.tenantId, userId: input.userId } });
  const membership = existing
    ? await db.membership.update({ where: { id: existing.id, tenantId: input.tenantId }, data: { role: input.role, status: 'ACTIVE', teamId: input.teamId ?? existing.teamId } })
    : await db.membership.create({
        data: { tenantId: input.tenantId, userId: input.userId, role: input.role, teamId: input.teamId ?? null, telephonyIdentity: newTelephonyIdentity() },
      });
  await db.agentState.upsert({
    where: { membershipId: membership.id, tenantId: input.tenantId },
    create: { membershipId: membership.id, tenantId: input.tenantId },
    update: {},
  });
  if (input.role === 'AGENT') {
    const defaultQueue = await db.queue.findFirst({ where: { tenantId: input.tenantId, isDefault: true } });
    if (defaultQueue) {
      await db.queueMember.upsert({
        where: { queueId_membershipId: { queueId: defaultQueue.id, membershipId: membership.id }, tenantId: input.tenantId },
        create: { tenantId: input.tenantId, queueId: defaultQueue.id, membershipId: membership.id },
        update: {},
      });
    }
  }
  return membership;
}
