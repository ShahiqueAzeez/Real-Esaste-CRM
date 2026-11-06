import { Injectable } from '@nestjs/common';
import type { queueSchema } from '@crm/shared';
import type { z } from 'zod';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TenantSettingsService } from '../org/org-core.service';
import { TelephonyRegistry } from '../telephony/registry.service';

export interface QueueCounts {
  queueId: string;
  ready: number;
  scheduled: number;
  callbacks: number;
  inProgress: number;
  done: number;
  eligibleNow: number;
}

@Injectable()
export class QueuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly telephony: TelephonyRegistry,
  ) {}

  /** Queue counts from persisted state; "eligibleNow" applies consent, suppression and attempt rules. */
  async counts(tenantId: string): Promise<Map<string, QueueCounts>> {
    const { settings } = await this.settings.get(tenantId);
    const requireConsent = settings.consent.requireConsentForCalls;
    const rows = await this.prisma.system.$queryRaw<
      { queueId: string; ready: bigint; scheduled: bigint; callbacks: bigint; inProgress: bigint; done: bigint; eligibleNow: bigint }[]
    >`
      SELECT qi."queueId",
        COUNT(*) FILTER (WHERE qi.state = 'WAITING' AND qi."availableAt" <= now()) AS ready,
        COUNT(*) FILTER (WHERE qi.state = 'WAITING' AND qi."availableAt" > now()) AS scheduled,
        COUNT(*) FILTER (WHERE qi.state = 'WAITING' AND qi."isCallback") AS callbacks,
        COUNT(*) FILTER (WHERE qi.state = 'IN_PROGRESS') AS "inProgress",
        COUNT(*) FILTER (WHERE qi.state = 'DONE') AS done,
        COUNT(*) FILTER (
          WHERE qi.state = 'WAITING' AND qi."availableAt" <= now() AND qi.attempts < ${settings.retry.maxAttempts}
            AND l.status NOT IN ('NOT_INTERESTED', 'CONVERTED', 'INVALID', 'DO_NOT_CALL', 'CLOSED')
            AND l."consentStatus" <> 'REVOKED'
            AND (${requireConsent} = false OR l."consentStatus" = 'GRANTED')
            AND NOT EXISTS (SELECT 1 FROM suppression_entries s WHERE s."tenantId" = qi."tenantId" AND s."phoneE164" = l."phoneE164"
              AND s.channel IN ('ALL', 'VOICE') AND (s."expiresAt" IS NULL OR s."expiresAt" > now()))
        ) AS "eligibleNow"
      FROM queue_items qi JOIN leads l ON l.id = qi."leadId"
      WHERE qi."tenantId" = ${tenantId}::uuid
      GROUP BY qi."queueId"`;
    return new Map(
      rows.map((r) => [
        r.queueId,
        { queueId: r.queueId, ready: Number(r.ready), scheduled: Number(r.scheduled), callbacks: Number(r.callbacks), inProgress: Number(r.inProgress), done: Number(r.done), eligibleNow: Number(r.eligibleNow) },
      ]),
    );
  }

  async list(ctx: RequestContext) {
    const memberFilter = ctx.role === 'AGENT' ? { members: { some: { membershipId: ctx.membershipId, tenantId: ctx.tenantId } } } : {};
    const [queues, counts] = await Promise.all([
      this.prisma.db.queue.findMany({
        where: { tenantId: ctx.tenantId, ...memberFilter },
        include: { members: { include: { membership: { select: { id: true, user: { select: { name: true } } } } } } },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      this.counts(ctx.tenantId),
    ]);
    const empty = (queueId: string): QueueCounts => ({ queueId, ready: 0, scheduled: 0, callbacks: 0, inProgress: 0, done: 0, eligibleNow: 0 });
    return queues.map((q) => ({
      id: q.id,
      name: q.name,
      description: q.description,
      isDefault: q.isDefault,
      active: q.active,
      callerId: ctx.role === 'AGENT' ? undefined : q.callerId,
      members: ctx.role === 'AGENT' ? undefined : q.members.map((m) => ({ membershipId: m.membershipId, name: m.membership.user.name })),
      counts: counts.get(q.id) ?? empty(q.id),
    }));
  }

  /**
   * A queue's caller ID must be a number the tenant's real provider account can present (in India,
   * a number rented on that Plivo account). Simulated providers accept any well-formed number.
   */
  private async validCallerId(tenantId: string, raw: string | null | undefined): Promise<string | null> {
    if (!raw) return null;
    // Same rule as the Integrations page: E.164 after removing formatting. The provider account,
    // not phone-number metadata, decides which numbers are usable (e.g. 140/1600 series).
    const callerId = raw.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(callerId)) throw Errors.validation([{ path: 'callerId', message: 'Enter the caller ID in international format, e.g. +914412345678' }]);
    const { provider } = await this.telephony.resolve(tenantId);
    const allowed = provider && !provider.capabilities.simulated ? provider.callerIds() : [];
    if (allowed.length && !allowed.includes(callerId)) {
      throw Errors.validation([{ path: 'callerId', message: `Use one of the numbers on your Plivo account: ${allowed.join(', ')}` }]);
    }
    return callerId;
  }

  async save(ctx: RequestContext, body: z.output<typeof queueSchema>, id?: string) {
    const callerId = await this.validCallerId(ctx.tenantId, body.callerId);
    const agents = await this.prisma.db.membership.findMany({ where: { tenantId: ctx.tenantId, id: { in: body.memberIds }, role: 'AGENT' }, select: { id: true } });
    if (agents.length !== body.memberIds.length) throw Errors.badRequest('INVALID_MEMBER', 'Queue members must be agents of this organization');
    if (id) {
      const existing = await this.prisma.db.queue.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw Errors.notFound('Queue');
      if (existing.isDefault && body.active === false) throw Errors.badRequest('DEFAULT_QUEUE', 'The default queue cannot be deactivated');
    }
    const queue = await this.prisma.db.$transaction(async (tx) => {
      const q = id
        ? await tx.queue.update({ where: { id, tenantId: ctx.tenantId }, data: { name: body.name, description: body.description, active: body.active, callerId } })
        : await tx.queue.create({ data: { tenantId: ctx.tenantId, name: body.name, description: body.description, active: body.active, callerId } });
      await tx.queueMember.deleteMany({ where: { tenantId: ctx.tenantId, queueId: q.id } });
      if (body.memberIds.length) await tx.queueMember.createMany({ data: body.memberIds.map((membershipId) => ({ tenantId: ctx.tenantId, queueId: q.id, membershipId })) });
      return q;
    });
    await this.audit.fromCtx(ctx, id ? 'queue.updated' : 'queue.created', 'queue', queue.id, { members: body.memberIds.length });
    return queue;
  }
}
