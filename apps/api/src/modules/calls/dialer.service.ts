import { Injectable, Logger } from '@nestjs/common';
import {
  CALL_STATUS_LABEL,
  isTerminalCall,
  isTerminalLeg,
  isWithinCallingHours,
  nextCallingWindowStart,
  RealtimeEvent,
  suggestedOutcomeFor,
  type CallStatus,
  type ExpectIncomingPayload,
} from '@crm/shared';
import { maskPhone } from '@crm/shared/phone';
import type { Call, CallLeg, Lead } from '@prisma/client';
import { AppConfig } from '../../config/config';
import type { RequestContext } from '../../common/auth-context';
import { SYNTHETIC_SOURCE } from '../../common/constants';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RealtimeService } from '../../infra/realtime/realtime.service';
import { AgentStateService } from '../agent/agent-state.service';
import { AuditService } from '../audit/audit.service';
import { ComplianceService, type IneligibleReason } from '../compliance/compliance.service';
import { EntitlementsService, ScopeService, TenantSettingsService } from '../org/org-core.service';
import { ReservationService } from '../queues/reservation.service';
import { ProviderError, type LegTarget } from '../telephony/provider';
import { TelephonyRegistry } from '../telephony/registry.service';
import type { SimStep } from '../telephony/mock.provider';
import { CallLifecycleService } from './call-lifecycle.service';

const DEVICE_CHECK_MAX_AGE_MS = 12 * 3600_000;
const PERMANENT_INELIGIBLE: IneligibleReason[] = ['SUPPRESSED', 'CONSENT_MISSING', 'CONSENT_REVOKED', 'FINAL_STATUS', 'COUNTRY_NOT_ALLOWED', 'MAX_ATTEMPTS'];

export type CallWithRelations = Call & { legs: CallLeg[]; lead: Lead };

@Injectable()
export class DialerService {
  private readonly logger = new Logger('Dialer');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: TenantSettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly compliance: ComplianceService,
    private readonly reservation: ReservationService,
    private readonly agents: AgentStateService,
    private readonly registry: TelephonyRegistry,
    private readonly lifecycle: CallLifecycleService,
    private readonly realtime: RealtimeService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  view(call: CallWithRelations, role: string) {
    const lead = call.lead;
    return {
      id: call.id,
      status: call.status,
      statusLabel: CALL_STATUS_LABEL[call.status as CallStatus],
      isSimulated: call.isSimulated,
      provider: call.provider,
      callingMode: call.callingMode,
      attemptNumber: call.attemptNumber,
      initiatedAt: call.initiatedAt,
      agentAnsweredAt: call.agentAnsweredAt,
      customerAnsweredAt: call.customerAnsweredAt,
      endedAt: call.endedAt,
      talkSeconds: call.talkSeconds,
      failureReason: call.failureReason,
      hangupCause: call.hangupCause,
      wrapUpStatus: call.wrapUpStatus,
      suggestedOutcome: suggestedOutcomeFor(call.status as CallStatus),
      recordingEnabled: call.recordingEnabled,
      legs: call.legs.map((l) => ({ id: l.id, role: l.role, status: l.status, answeredAt: l.answeredAt, endedAt: l.endedAt })),
      lead: {
        id: lead.id,
        fullName: lead.fullName,
        phone: role === 'AGENT' ? maskPhone(lead.phoneE164) : lead.phoneE164,
        email: lead.email,
        propertyInterest: lead.propertyInterest,
        preferredLocation: lead.preferredLocation,
        budgetMin: lead.budgetMin,
        budgetMax: lead.budgetMax,
        source: lead.source,
        status: lead.status,
        priority: lead.priority,
        attemptCount: lead.attemptCount,
        consentStatus: lead.consentStatus,
        lastCallOutcome: lead.lastCallOutcome,
      },
    };
  }

  private async loadForCtx(ctx: RequestContext, callId: string): Promise<CallWithRelations> {
    const where = await this.scope.callWhere(ctx);
    const call = await this.prisma.db.call.findFirst({
      where: { AND: [where, { id: callId, tenantId: ctx.tenantId }], tenantId: ctx.tenantId },
      include: { legs: true, lead: true },
    });
    if (!call) throw Errors.notFound('Call');
    return call;
  }

  async current(ctx: RequestContext) {
    const state = await this.prisma.db.agentState.findFirst({ where: { membershipId: ctx.membershipId, tenantId: ctx.tenantId } });
    let call = state?.currentCallId
      ? await this.prisma.db.call.findFirst({ where: { id: state.currentCallId, tenantId: ctx.tenantId }, include: { legs: true, lead: true } })
      : null;
    // A finished call that still needs an outcome stays on screen.
    call ??= await this.prisma.db.call.findFirst({
      where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId, wrapUpStatus: 'PENDING', status: { in: ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'] } },
      orderBy: { initiatedAt: 'desc' },
      include: { legs: true, lead: true },
    });
    return call ? this.view(call, ctx.role) : null;
  }

  /**
   * Progressive dialling: reserve one eligible lead for this agent and ring the agent first.
   * Safe against double clicks (Idempotency-Key + per-agent advisory lock + agent state check)
   * and concurrent agents (SKIP LOCKED reservation).
   */
  async dialNext(ctx: RequestContext, idempotencyKey: string | undefined) {
    const key = idempotencyKey ? `${ctx.membershipId}:${idempotencyKey.slice(0, 100)}` : null;
    if (key) {
      const existing = await this.prisma.db.call.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: key }, include: { legs: true, lead: true } });
      if (existing) return { result: 'EXISTING' as const, call: this.view(existing, ctx.role) };
    }
    const now = new Date();
    const { settings, timezone } = await this.settings.get(ctx.tenantId);
    if (!isWithinCallingHours(now, settings.callingHours, timezone)) {
      const next = nextCallingWindowStart(now, settings.callingHours, timezone);
      throw Errors.conflict('OUTSIDE_CALLING_HOURS', 'Calls can only be placed during your organization’s calling hours.', { nextWindowAt: next });
    }
    const membership = await this.prisma.db.membership.findFirstOrThrow({ where: { id: ctx.membershipId, tenantId: ctx.tenantId } });
    const mode = membership.callingMode ?? settings.calling.defaultMode;
    const provider = await this.registry.forTenant(ctx.tenantId);
    let target: LegTarget;
    if (mode === 'PHONE') {
      if (!membership.agentPhoneE164) throw Errors.precondition('AGENT_PHONE_MISSING', 'Phone mode needs your phone number. Ask an administrator to add it to your profile.');
      target = { kind: 'PSTN', address: membership.agentPhoneE164 };
    } else {
      const state = await this.prisma.db.agentState.findFirst({ where: { membershipId: ctx.membershipId, tenantId: ctx.tenantId } });
      if (!state?.deviceCheckedAt || now.getTime() - state.deviceCheckedAt.getTime() > DEVICE_CHECK_MAX_AGE_MS) {
        throw Errors.precondition('DEVICE_CHECK_REQUIRED', 'Run the audio device check before calling.');
      }
      if (!provider.capabilities.simulated && (state.microphone !== 'granted' || !state.providerRegistered)) {
        throw Errors.precondition('BROWSER_NOT_READY', 'Your browser is not ready: allow the microphone and wait for “Calling service connected”.');
      }
      target = provider.browserTarget(membership.telephonyIdentity);
    }
    const lastHour = await this.prisma.db.call.count({ where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId, initiatedAt: { gte: new Date(now.getTime() - 3600_000) } } });
    if (lastHour >= settings.calling.maxCallsPerAgentPerHour) throw Errors.tooMany('You have reached the hourly call limit set by your organization.');
    const sub = await this.entitlements.assertOperational(ctx.tenantId);
    const recording = settings.recording.enabled && this.entitlements.features(sub.plan).recording && provider.capabilities.recording;

    const result = await this.prisma.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.membershipId}))`;
        if (key) {
          const existing = await tx.call.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: key }, include: { legs: true, lead: true } });
          if (existing) return { kind: 'existing' as const, call: existing };
        }
        const state = await this.agents.lock(tx, ctx.tenantId, ctx.membershipId);
        if (!state) throw Errors.precondition('NOT_READY', 'Set yourself Ready first');
        if (state.status === 'WRAP_UP') throw Errors.conflict('WRAP_UP_PENDING', 'Save the outcome of your last call first');
        if (state.status === 'DIALING' || state.status === 'ON_CALL') throw Errors.conflict('CALL_IN_PROGRESS', 'You are already on a call', { callId: state.currentCallId });
        if (state.status !== 'READY') throw Errors.conflict('NOT_READY', 'Set yourself Ready first');
        const pending = await tx.call.findFirst({ where: { tenantId: ctx.tenantId, membershipId: ctx.membershipId, wrapUpStatus: 'PENDING', status: { in: ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'] } }, select: { id: true } });
        if (pending) throw Errors.conflict('WRAP_UP_PENDING', 'Save the outcome of your last call first', { callId: pending.id });
        await this.entitlements.assertConcurrentCallCapacity(ctx.tenantId, tx);

        const excluded: string[] = [];
        let chosen: { item: Awaited<ReturnType<ReservationService['reserveNext']>>; lead: Lead } | null = null;
        for (let i = 0; i < 5 && !chosen; i++) {
          const item = await this.reservation.reserveNext(tx, { tenantId: ctx.tenantId, membershipId: ctx.membershipId, settings, now, excludeIds: excluded });
          if (!item) break;
          const lead = await tx.lead.findFirstOrThrow({ where: { id: item.leadId, tenantId: ctx.tenantId } });
          const reasons: string[] = await this.compliance.voiceEligibility(tx, ctx.tenantId, lead, { settings, timezone, attempts: item.attempts, now });
          // Seeded demo numbers are synthetic: never send them to a real carrier.
          if (!provider.capabilities.simulated && lead.source === SYNTHETIC_SOURCE) reasons.push('SYNTHETIC_LEAD');
          if (reasons.length) {
            const permanent = reasons.find((r) => (PERMANENT_INELIGIBLE as string[]).includes(r) || r === 'SYNTHETIC_LEAD');
            await tx.queueItem.update({
              where: { id: item.id, tenantId: ctx.tenantId },
              data: permanent ? { state: 'DONE', doneReason: permanent, reservedByMembershipId: null } : { state: 'WAITING', reservedByMembershipId: null },
            });
            await tx.leadActivity.create({ data: { tenantId: ctx.tenantId, leadId: lead.id, type: 'SKIPPED_INELIGIBLE', data: { reasons } } });
            excluded.push(item.id);
            continue;
          }
          chosen = { item, lead };
        }
        if (!chosen || !chosen.item) return { kind: 'none' as const, nextAvailableAt: await this.reservation.nextAvailableAt(tx, ctx.tenantId, ctx.membershipId) };

        const queue = await tx.queue.findFirstOrThrow({ where: { id: chosen.item.queueId, tenantId: ctx.tenantId } });
        const callerId = queue.callerId ?? provider.defaultCallerId();
        if (!callerId) throw Errors.precondition('NO_CALLER_ID', 'No caller ID is configured. Add a Plivo number in Settings → Integrations.');
        const call = await tx.call.create({
          data: {
            tenantId: ctx.tenantId,
            leadId: chosen.lead.id,
            membershipId: ctx.membershipId,
            queueId: queue.id,
            queueItemId: chosen.item.id,
            provider: provider.kind,
            isSimulated: provider.capabilities.simulated,
            callingMode: mode,
            fromNumber: callerId,
            toNumberE164: chosen.lead.phoneE164,
            idempotencyKey: key,
            attemptNumber: chosen.item.attempts + 1,
            recordingEnabled: recording,
          },
        });
        await tx.callLeg.create({ data: { tenantId: ctx.tenantId, callId: call.id, role: 'AGENT', provider: provider.kind, toAddress: target.address, fromNumber: callerId, status: 'QUEUED' } });
        const transition = await this.agents.set(tx, { tenantId: ctx.tenantId, membershipId: ctx.membershipId, status: 'DIALING', currentCallId: call.id });
        await tx.leadActivity.create({ data: { tenantId: ctx.tenantId, leadId: chosen.lead.id, type: 'CALL_STARTED', actorMembershipId: ctx.membershipId, data: { callId: call.id, simulated: provider.capabilities.simulated } } });
        const full = await tx.call.findFirstOrThrow({ where: { id: call.id, tenantId: ctx.tenantId }, include: { legs: true, lead: true } });
        return { kind: 'created' as const, call: full, transition };
      },
      { timeout: 20_000 },
    );

    if (result.kind === 'existing') return { result: 'EXISTING' as const, call: this.view(result.call, ctx.role) };
    if (result.kind === 'none') return { result: 'NO_LEADS' as const, nextAvailableAt: result.nextAvailableAt };

    await this.agents.publish(result.transition);
    const call = result.call;
    const agentLeg = call.legs[0]!;
    if (mode === 'BROWSER' && !provider.capabilities.simulated) {
      const payload: ExpectIncomingPayload = { callId: call.id, purpose: 'AGENT_LEG', expiresAt: new Date(Date.now() + 45_000).toISOString() };
      await this.realtime.toMembership(ctx.membershipId, RealtimeEvent.EXPECT_INCOMING, payload);
    }
    try {
      const res = await provider.startLeg({
        tenantId: ctx.tenantId,
        callId: call.id,
        legId: agentLeg.id,
        role: 'AGENT',
        from: call.fromNumber!,
        to: target,
        ringTimeoutSeconds: settings.calling.agentRingTimeoutSeconds,
        timeLimitSeconds: settings.calling.maxCallMinutes * 60,
      });
      await this.prisma.system.callLeg.updateMany({ where: { id: agentLeg.id, status: 'QUEUED' }, data: { status: 'INITIATED', initiatedAt: new Date() } });
      await this.prisma.system.callLeg.updateMany({ where: { id: agentLeg.id, providerRequestId: null }, data: { providerRequestId: res.providerRequestId } });
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : `Unexpected error: ${(err as Error).message}`;
      this.logger.error(`Agent leg for call ${call.id} failed: ${message}`);
      await this.recordIntegrationError(ctx.tenantId, message);
      await this.lifecycle.systemEndLeg(call, agentLeg.id, 'FAILED', `provider_error: ${message}`.slice(0, 300));
    }
    const fresh = await this.prisma.db.call.findFirstOrThrow({ where: { id: call.id, tenantId: ctx.tenantId }, include: { legs: true, lead: true } });
    await this.lifecycle.publishCall(fresh);
    return { result: 'DIALING' as const, call: this.view(fresh, ctx.role) };
  }

  private async recordIntegrationError(tenantId: string, message: string) {
    await this.prisma.system.providerConfig
      .updateMany({ where: { tenantId, provider: 'PLIVO' }, data: { lastError: message.slice(0, 500), lastCheckedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Worker: dial the customer once the agent leg is connected. Never retried automatically. */
  async startCustomerLeg(tenantId: string, callId: string): Promise<void> {
    const call = await this.prisma.system.call.findUnique({ where: { id: callId }, include: { legs: true, lead: true } });
    if (!call || call.tenantId !== tenantId || isTerminalCall(call.status as CallStatus)) return;
    const leg = call.legs.find((l) => l.role === 'CUSTOMER' && l.status === 'QUEUED');
    if (!leg) return;
    const { settings, timezone } = await this.settings.get(tenantId);
    const reasons = await this.compliance.voiceEligibility(this.prisma.system, tenantId, call.lead, { settings, timezone, ignoreHours: true });
    if (reasons.length) {
      this.logger.warn(`Call ${callId} blocked before dialling the customer: ${reasons.join(',')}`);
      if (call.queueItemId) {
        await this.prisma.system.queueItem.updateMany({ where: { id: call.queueItemId, state: 'IN_PROGRESS' }, data: { state: 'DONE', doneReason: reasons[0] } });
      }
      await this.lifecycle.systemEndLeg(call, leg.id, 'FAILED', 'COMPLIANCE_BLOCK');
      return;
    }
    const provider = await this.registry.forCall(tenantId, call.provider);
    let providerRequestId: string;
    try {
      const res = await provider.startLeg({
        tenantId,
        callId,
        legId: leg.id,
        role: 'CUSTOMER',
        from: call.fromNumber!,
        to: { kind: 'PSTN', address: call.toNumberE164 },
        ringTimeoutSeconds: settings.calling.customerRingTimeoutSeconds,
        timeLimitSeconds: settings.calling.maxCallMinutes * 60,
      });
      providerRequestId = res.providerRequestId;
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : (err as Error).message;
      await this.recordIntegrationError(tenantId, message);
      await this.lifecycle.systemEndLeg(call, leg.id, 'FAILED', `provider_error: ${message}`.slice(0, 300));
      return;
    }
    const after = await this.prisma.system.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM calls WHERE id = ${callId}::uuid FOR UPDATE`;
      await tx.callLeg.updateMany({ where: { id: leg.id, status: 'QUEUED' }, data: { status: 'INITIATED', initiatedAt: new Date() } });
      await tx.callLeg.updateMany({ where: { id: leg.id, providerRequestId: null }, data: { providerRequestId } });
      await this.lifecycle.markAttempt(tx, call);
      return tx.call.findUniqueOrThrow({ where: { id: callId }, include: { legs: true } });
    });
    if (isTerminalCall(after.status as CallStatus)) {
      // The agent dropped while we were dialling: stop ringing the customer.
      const l = after.legs.find((x) => x.id === leg.id)!;
      await provider.hangupLeg({ providerCallId: l.providerCallId, providerRequestId, legId: l.id, callId, tenantId, answered: l.everAnswered }).catch(() => undefined);
    }
    await this.lifecycle.publishCall(after);
  }

  /** Hang up every leg that is still active. Used by agents, recovery and finalization. */
  async hangupCall(tenantId: string, callId: string): Promise<void> {
    const call = await this.prisma.system.call.findUnique({ where: { id: callId }, include: { legs: true } });
    if (!call || call.tenantId !== tenantId) return;
    const provider = await this.registry.forCall(tenantId, call.provider);
    for (const leg of call.legs) {
      if (isTerminalLeg(leg.status)) continue;
      if (leg.status === 'QUEUED' && !leg.providerRequestId) {
        await this.lifecycle.systemEndLeg(call, leg.id, 'CANCELLED', 'not_placed');
        continue;
      }
      await provider.hangupLeg({ providerCallId: leg.providerCallId, providerRequestId: leg.providerRequestId, legId: leg.id, callId, tenantId, answered: leg.everAnswered });
    }
  }

  async agentHangup(ctx: RequestContext, callId: string) {
    const call = await this.loadForCtx(ctx, callId);
    if (call.membershipId !== ctx.membershipId) throw Errors.forbidden('Only the agent on the call can hang it up');
    if (isTerminalCall(call.status as CallStatus)) return this.view(call, ctx.role);
    try {
      await this.hangupCall(ctx.tenantId, callId);
    } catch (err) {
      throw Errors.unavailable('PROVIDER_ERROR', `Could not hang up through the provider: ${(err as Error).message}. Hang up from your phone or browser; the call will be reconciled.`);
    }
    return this.view(await this.loadForCtx(ctx, callId), ctx.role);
  }

  async getCall(ctx: RequestContext, callId: string) {
    return this.view(await this.loadForCtx(ctx, callId), ctx.role);
  }

  /** Mock-mode simulation controls (labelled SIMULATED in the UI). */
  async simulate(ctx: RequestContext, callId: string, action: 'answer' | 'busy' | 'no-answer' | 'fail' | 'customer-hangup') {
    if (!this.config.env.ALLOW_MOCK_CONTROLS) throw Errors.forbidden('Simulation controls are disabled');
    const call = await this.loadForCtx(ctx, callId);
    if (!call.isSimulated) throw Errors.badRequest('NOT_SIMULATED', 'Simulation controls only work on simulated calls');
    const leg = call.legs.find((l) => l.role === 'CUSTOMER' && !isTerminalLeg(l.status));
    if (!leg) throw Errors.conflict('NO_CUSTOMER_LEG', 'The customer is not being dialled right now');
    const step: SimStep = action === 'answer' ? 'answered' : action === 'busy' ? 'busy' : action === 'no-answer' ? 'no-answer' : action === 'fail' ? 'failed' : 'hangup';
    await this.registry.mock().forceStep({ tenantId: ctx.tenantId, callId, legId: leg.id }, step);
    return { scheduled: step };
  }

  /** Worker: pull the provider CDR for authoritative bill seconds and cost. */
  async fetchCdr(tenantId: string, legId: string): Promise<void> {
    const leg = await this.prisma.system.callLeg.findUnique({ where: { id: legId }, include: { call: true } });
    if (!leg || leg.tenantId !== tenantId || leg.costSource === 'PROVIDER' || !leg.providerCallId) return;
    const provider = await this.registry.forCall(tenantId, leg.provider);
    const cdr = await provider.getCallDetails(leg.providerCallId);
    if (!cdr) throw new Error('CDR not available yet');
    await this.prisma.system.$transaction(async (tx) => {
      await tx.callLeg.update({
        where: { id: legId },
        data: {
          billSeconds: cdr.billSeconds ?? leg.billSeconds,
          durationSeconds: cdr.durationSeconds ?? leg.durationSeconds,
          ...(cdr.costMicros != null ? { costMicros: cdr.costMicros, costCurrency: cdr.currency, costSource: 'PROVIDER' as const } : {}),
        },
      });
      if (cdr.costMicros != null) await this.lifecycle.upsertCost(tx, tenantId, legId, cdr.costMicros, cdr.currency, false, leg.endedAt ?? new Date());
      const legs = await tx.callLeg.findMany({ where: { callId: leg.callId } });
      const costed = legs.filter((l) => l.costMicros != null);
      const currencies = new Set(costed.map((l) => l.costCurrency));
      await tx.call.update({
        where: { id: leg.callId },
        data: {
          billableSeconds: legs.reduce((s, l) => s + (l.billSeconds ?? 0), 0),
          costMicros: currencies.size === 1 ? costed.reduce((s, l) => s + (l.costMicros ?? 0n), 0n) : null,
          costCurrency: currencies.size === 1 ? [...currencies][0] : null,
          costSource: costed.length && costed.every((l) => l.costSource === 'PROVIDER') ? 'PROVIDER' : costed.length ? 'ESTIMATE' : 'NONE',
        },
      });
    });
  }
}
