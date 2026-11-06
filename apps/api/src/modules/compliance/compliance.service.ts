import { Global, Injectable, Module } from '@nestjs/common';
import {
  FINAL_LEAD_STATUSES,
  isWithinCallingHours,
  type ConsentStatus,
  type SuppressionChannel,
  type SuppressionReason,
  type TenantSettings,
} from '@crm/shared';
import { normalizePhone, phoneCountry } from '@crm/shared/phone';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export type IneligibleReason =
  | 'SUPPRESSED'
  | 'CONSENT_MISSING'
  | 'CONSENT_REVOKED'
  | 'FINAL_STATUS'
  | 'COUNTRY_NOT_ALLOWED'
  | 'OUTSIDE_CALLING_HOURS'
  | 'MAX_ATTEMPTS';

export const INELIGIBLE_LABEL: Record<IneligibleReason, string> = {
  SUPPRESSED: 'Number is on the do-not-call / opt-out list',
  CONSENT_MISSING: 'No recorded consent to call',
  CONSENT_REVOKED: 'Consent was withdrawn',
  FINAL_STATUS: 'Lead is closed',
  COUNTRY_NOT_ALLOWED: 'Destination country is not allowed',
  OUTSIDE_CALLING_HOURS: 'Outside calling hours',
  MAX_ATTEMPTS: 'Maximum attempts reached',
};

interface LeadForEligibility {
  phoneE164: string;
  status: string;
  consentStatus: string;
}

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  suppressionChannels(channel: 'VOICE' | 'WHATSAPP'): SuppressionChannel[] {
    return ['ALL', channel];
  }

  async isSuppressed(db: Tx | PrismaService['db'], tenantId: string, phoneE164: string, channel: 'VOICE' | 'WHATSAPP', now = new Date()): Promise<boolean> {
    const hit = await db.suppressionEntry.findFirst({
      where: { tenantId, phoneE164, channel: { in: this.suppressionChannels(channel) }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { id: true },
    });
    return !!hit;
  }

  /**
   * Full voice eligibility check for one lead, run again right before dialling even though the
   * reservation query already filters on the same rules (defence in depth).
   */
  async voiceEligibility(
    db: Tx | PrismaService['db'],
    tenantId: string,
    lead: LeadForEligibility,
    ctx: { settings: TenantSettings; timezone: string; attempts?: number; now?: Date; ignoreHours?: boolean },
  ): Promise<IneligibleReason[]> {
    const now = ctx.now ?? new Date();
    const reasons: IneligibleReason[] = [];
    if (await this.isSuppressed(db, tenantId, lead.phoneE164, 'VOICE', now)) reasons.push('SUPPRESSED');
    if (lead.consentStatus === 'REVOKED') reasons.push('CONSENT_REVOKED');
    else if (ctx.settings.consent.requireConsentForCalls && lead.consentStatus !== 'GRANTED') reasons.push('CONSENT_MISSING');
    if ((FINAL_LEAD_STATUSES as string[]).includes(lead.status)) reasons.push('FINAL_STATUS');
    const country = phoneCountry(lead.phoneE164);
    if (!country || !ctx.settings.calling.allowedCountries.includes(country)) reasons.push('COUNTRY_NOT_ALLOWED');
    if (!ctx.ignoreHours && !isWithinCallingHours(now, ctx.settings.callingHours, ctx.timezone)) reasons.push('OUTSIDE_CALLING_HOURS');
    if (ctx.attempts !== undefined && ctx.attempts >= ctx.settings.retry.maxAttempts) reasons.push('MAX_ATTEMPTS');
    return reasons;
  }

  async listSuppressions(ctx: RequestContext, q: string | undefined, page: number, pageSize: number) {
    const where: Prisma.SuppressionEntryWhereInput = { tenantId: ctx.tenantId, ...(q ? { phoneE164: { contains: q.replace(/[^\d+]/g, '') } } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.db.suppressionEntry.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(page, pageSize) }),
      this.prisma.db.suppressionEntry.count({ where }),
    ]);
    return toPage(items, total, page, pageSize);
  }

  /**
   * Add a number to the suppression list and immediately stop any dialling or follow-up for
   * matching leads. Usable inside a larger transaction (wrap-up) or standalone.
   */
  async suppress(
    tx: Tx,
    input: { tenantId: string; phoneE164: string; channel: SuppressionChannel; reason: SuppressionReason; note?: string | null; source: string; membershipId?: string | null; expiresAt?: Date | null },
  ) {
    const entry = await tx.suppressionEntry.upsert({
      where: { tenantId_phoneE164_channel: { tenantId: input.tenantId, phoneE164: input.phoneE164, channel: input.channel } },
      create: {
        tenantId: input.tenantId,
        phoneE164: input.phoneE164,
        channel: input.channel,
        reason: input.reason,
        note: input.note ?? null,
        source: input.source,
        createdByMembershipId: input.membershipId ?? null,
        expiresAt: input.expiresAt ?? null,
      },
      update: { reason: input.reason, note: input.note ?? undefined, expiresAt: input.expiresAt ?? null },
    });
    if (input.channel !== 'WHATSAPP') {
      const leads = await tx.lead.findMany({ where: { tenantId: input.tenantId, phoneE164: input.phoneE164 }, select: { id: true } });
      const leadIds = leads.map((l) => l.id);
      if (leadIds.length) {
        await tx.queueItem.updateMany({
          where: { tenantId: input.tenantId, leadId: { in: leadIds }, state: 'WAITING' },
          data: { state: 'DONE', doneReason: 'SUPPRESSED' },
        });
        await tx.callback.updateMany({ where: { tenantId: input.tenantId, leadId: { in: leadIds }, status: 'PENDING' }, data: { status: 'CANCELLED' } });
        if (input.reason === 'DO_NOT_CALL' || input.reason === 'OPT_OUT') {
          await tx.lead.updateMany({ where: { tenantId: input.tenantId, id: { in: leadIds } }, data: { status: 'DO_NOT_CALL', nextCallbackAt: null } });
        }
        await tx.leadActivity.createMany({
          data: leadIds.map((leadId) => ({ tenantId: input.tenantId, leadId, type: 'SUPPRESSED', actorMembershipId: input.membershipId ?? null, data: { reason: input.reason, channel: input.channel, source: input.source } })),
        });
      }
    }
    return entry;
  }

  async addSuppression(ctx: RequestContext, body: { phone: string; channel: SuppressionChannel; reason: SuppressionReason; note?: string | null; expiresAt?: Date | null }) {
    const parsed = normalizePhone(body.phone, 'IN');
    if (!parsed.ok) throw Errors.badRequest('INVALID_PHONE', 'Enter a valid phone number');
    const entry = await this.prisma.db.$transaction((tx) =>
      this.suppress(tx, { tenantId: ctx.tenantId, phoneE164: parsed.value.e164, channel: body.channel, reason: body.reason, note: body.note, source: 'manual', membershipId: ctx.membershipId, expiresAt: body.expiresAt }),
    );
    await this.audit.fromCtx(ctx, 'suppression.added', 'suppression', entry.id, { reason: body.reason, channel: body.channel });
    return entry;
  }

  async bulkSuppress(ctx: RequestContext, phones: string[], reason: SuppressionReason, channel: SuppressionChannel) {
    let added = 0;
    const invalid: string[] = [];
    const unique = new Set<string>();
    for (const raw of phones) {
      const parsed = normalizePhone(raw, 'IN');
      if (parsed.ok) unique.add(parsed.value.e164);
      else if (invalid.length < 100) invalid.push(String(raw).slice(0, 40));
    }
    const list = [...unique];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      await this.prisma.db.$transaction(async (tx) => {
        for (const phoneE164 of chunk) {
          await this.suppress(tx, { tenantId: ctx.tenantId, phoneE164, channel, reason, source: 'bulk_upload', membershipId: ctx.membershipId });
          added++;
        }
      });
    }
    await this.audit.fromCtx(ctx, 'suppression.bulk_added', 'suppression', undefined, { added, invalid: invalid.length, reason });
    return { added, invalidCount: phones.length - unique.size, invalidSample: invalid };
  }

  async removeSuppression(ctx: RequestContext, id: string) {
    const entry = await this.prisma.db.suppressionEntry.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!entry) throw Errors.notFound('Suppression entry');
    await this.prisma.db.suppressionEntry.delete({ where: { id: entry.id, tenantId: ctx.tenantId } });
    await this.audit.fromCtx(ctx, 'suppression.removed', 'suppression', id, { reason: entry.reason, channel: entry.channel });
  }

  /** Record a consent change with evidence; keeps the lead's current state and a history row. */
  async recordConsent(
    tx: Tx,
    input: { tenantId: string; leadId: string; phoneE164: string; status: ConsentStatus; source: string; evidence?: string | null; capturedAt?: Date | null; membershipId?: string | null },
  ) {
    await tx.consentRecord.create({
      data: {
        tenantId: input.tenantId,
        leadId: input.leadId,
        phoneE164: input.phoneE164,
        status: input.status,
        source: input.source,
        evidence: input.evidence ?? null,
        capturedAt: input.capturedAt ?? null,
        recordedByMembershipId: input.membershipId ?? null,
      },
    });
    await tx.lead.update({
      where: { id: input.leadId, tenantId: input.tenantId },
      data: { consentStatus: input.status, consentSource: input.source, consentEvidence: input.evidence ?? null, consentCapturedAt: input.capturedAt ?? new Date() },
    });
    await tx.leadActivity.create({
      data: { tenantId: input.tenantId, leadId: input.leadId, type: 'CONSENT_UPDATED', actorMembershipId: input.membershipId ?? null, data: { status: input.status, source: input.source } },
    });
    if (input.status === 'REVOKED') {
      await tx.queueItem.updateMany({ where: { tenantId: input.tenantId, leadId: input.leadId, state: 'WAITING' }, data: { state: 'DONE', doneReason: 'CONSENT_REVOKED' } });
      await tx.callback.updateMany({ where: { tenantId: input.tenantId, leadId: input.leadId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    }
  }

  async summary(ctx: RequestContext) {
    const [suppressed, consentGranted, consentUnknown, consentRevoked] = await Promise.all([
      this.prisma.db.suppressionEntry.count({ where: { tenantId: ctx.tenantId } }),
      this.prisma.db.lead.count({ where: { tenantId: ctx.tenantId, consentStatus: 'GRANTED' } }),
      this.prisma.db.lead.count({ where: { tenantId: ctx.tenantId, consentStatus: 'UNKNOWN' } }),
      this.prisma.db.lead.count({ where: { tenantId: ctx.tenantId, consentStatus: 'REVOKED' } }),
    ]);
    return { suppressed, consent: { granted: consentGranted, unknown: consentUnknown, revoked: consentRevoked } };
  }
}

@Global()
@Module({ providers: [ComplianceService], exports: [ComplianceService] })
export class ComplianceCoreModule {}
