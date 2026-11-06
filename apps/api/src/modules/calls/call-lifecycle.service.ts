import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import {
  applyLegEvent,
  deriveCallStatus,
  isTerminalCall,
  isTerminalLeg,
  RealtimeEvent,
  suggestedOutcomeFor,
  type CallStatus,
  type CallUpdatedPayload,
  type LegEndStatus,
  type LegEvent,
} from '@crm/shared';
import type { Call, CallLeg, Prisma } from '@prisma/client';
import { JobsService } from '../../infra/jobs/jobs.module';
import { isUniqueViolation, PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { RealtimeService } from '../../infra/realtime/realtime.service';
import { AgentStateService, type AgentTransition } from '../agent/agent-state.service';
import { TenantSettingsService } from '../org/org-core.service';
import type { ProviderEvent } from '../telephony/provider';
import { WrapUpService } from './wrap-up.service';

type CallWithLegs = Call & { legs: CallLeg[] };

export type Effect =
  | { kind: 'START_CUSTOMER_LEG' }
  | { kind: 'HANGUP_ACTIVE_LEGS'; reason: string }
  | { kind: 'FETCH_CDR'; legId: string }
  | { kind: 'AGENT'; transition: AgentTransition }
  | { kind: 'FOLLOW_UP'; callId: string; outcomeCode: string };

const ACTIVE: CallStatus[] = ['INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED'];

function serializeEvent(evt: ProviderEvent): Prisma.InputJsonValue {
  const { raw, ...normalized } = evt;
  return JSON.parse(JSON.stringify({ normalized: { ...normalized, costMicros: evt.costMicros?.toString() ?? null }, raw })) as Prisma.InputJsonValue;
}

function hydrateEvent(payload: Prisma.JsonValue): ProviderEvent {
  const p = payload as { normalized: Record<string, unknown>; raw: Record<string, unknown> };
  const n = p.normalized;
  return {
    ...(n as unknown as ProviderEvent),
    occurredAt: new Date(n.occurredAt as string),
    costMicros: n.costMicros ? BigInt(n.costMicros as string) : null,
    raw: p.raw,
  };
}

/**
 * Applies provider events to calls. Every event is stored once (unique provider+dedupe key)
 * before processing, applied under a row lock on the call, and processed exactly once
 * (processedAt). Duplicate, late and out-of-order events are absorbed by the leg state machine.
 */
@Injectable()
export class CallLifecycleService {
  private readonly logger = new Logger('CallLifecycle');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly realtime: RealtimeService,
    private readonly agents: AgentStateService,
    private readonly settings: TenantSettingsService,
    @Inject(forwardRef(() => WrapUpService)) private readonly wrapUp: WrapUpService,
  ) {}

  /** Store the event; returns null when it was already received (idempotency). */
  async record(evt: ProviderEvent): Promise<string | null> {
    try {
      const row = await this.prisma.system.callEvent.create({
        data: {
          tenantId: evt.tenantId,
          callId: evt.callId,
          legId: evt.legId,
          provider: evt.provider,
          source: evt.source,
          type: evt.type,
          dedupeKey: evt.dedupeKey,
          signatureValid: evt.signatureValid ?? null,
          payload: serializeEvent(evt),
          occurredAt: evt.occurredAt,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /** Store and apply an event. Failures are retried by the call-events queue. */
  async ingest(evt: ProviderEvent): Promise<{ duplicate: boolean; eventId?: string }> {
    const eventId = await this.record(evt);
    if (!eventId) return { duplicate: true };
    try {
      await this.process(eventId, evt);
    } catch (err) {
      this.logger.warn(`Event ${eventId} (${evt.type}) failed, will retry: ${(err as Error).message}`);
      await this.prisma.system.callEvent.update({ where: { id: eventId }, data: { processingError: (err as Error).message.slice(0, 500), attempts: { increment: 1 } } });
      await this.jobs.add('call-events.process', { eventId }, { jobId: `evt-${eventId}`, delay: 1000, attempts: 8 });
    }
    return { duplicate: false, eventId };
  }

  async processStored(eventId: string): Promise<void> {
    const row = await this.prisma.system.callEvent.findUnique({ where: { id: eventId } });
    if (!row || row.processedAt) return;
    await this.process(eventId, hydrateEvent(row.payload));
  }

  /**
   * Count the customer attempt exactly once, whichever happens first: the dialer confirming the
   * provider accepted the call, or a provider event for the customer leg.
   */
  async markAttempt(tx: Tx, call: { id: string; tenantId: string; leadId: string; membershipId: string; queueItemId: string | null }): Promise<boolean> {
    const item = call.queueItemId ? await tx.queueItem.findUnique({ where: { id: call.queueItemId } }) : null;
    const attempt = (item?.attempts ?? 0) + 1;
    const res = await tx.call.updateMany({ where: { id: call.id, tenantId: call.tenantId, countedAsAttempt: false }, data: { countedAsAttempt: true, attemptNumber: attempt } });
    if (res.count === 0) return false;
    if (item) await tx.queueItem.update({ where: { id: item.id }, data: { attempts: { increment: 1 }, lastAttemptAt: new Date() } });
    await tx.lead.update({ where: { id: call.leadId }, data: { attemptCount: { increment: 1 }, lastCallAt: new Date() } });
    await tx.leadActivity.create({ data: { tenantId: call.tenantId, leadId: call.leadId, type: 'CALL_ATTEMPT', actorMembershipId: call.membershipId, data: { callId: call.id, attempt } } });
    return true;
  }

  /** Emit a system-generated end for a leg (provider errors, compliance blocks, recovery). */
  async systemEndLeg(call: { id: string; tenantId: string; provider: 'PLIVO' | 'MOCK' }, legId: string, endStatus: LegEndStatus, cause: string): Promise<void> {
    await this.ingest({
      provider: call.provider,
      source: 'system',
      tenantId: call.tenantId,
      callId: call.id,
      legId,
      type: 'LEG_ENDED',
      dedupeKey: `system-end:${legId}`,
      occurredAt: new Date(),
      endStatus,
      hangupCause: cause,
      hangupSource: 'system',
      raw: { cause },
    });
  }

  private async process(eventId: string, evt: ProviderEvent): Promise<void> {
    const effects: Effect[] = [];
    let snapshot: CallWithLegs | null = null;
    await this.prisma.system.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM calls WHERE id = ${evt.callId}::uuid FOR UPDATE`;
        const call = await tx.call.findUnique({ where: { id: evt.callId }, include: { legs: true } });
        const markProcessed = (note?: string) =>
          tx.callEvent.update({ where: { id: eventId }, data: { processedAt: new Date(), processingError: note ?? null, attempts: { increment: 1 } } });
        if (!call || call.tenantId !== evt.tenantId) return void (await markProcessed('call not found'));
        const leg = call.legs.find((l) => l.id === evt.legId);
        if (!leg) return void (await markProcessed('leg not found'));

        if (evt.type === 'RECORDING') {
          await this.applyRecording(tx, call, evt);
          await markProcessed();
          snapshot = call;
          return;
        }
        if (evt.type === 'MPC_STATUS') return void (await markProcessed());

        const legEvent: LegEvent = evt.type === 'LEG_RINGING' ? { type: 'RINGING' } : evt.type === 'LEG_ANSWERED' ? { type: 'ANSWERED' } : { type: 'ENDED', endStatus: evt.endStatus ?? 'FAILED' };
        const t = applyLegEvent(leg.status, legEvent);
        const legData: Prisma.CallLegUpdateInput = {};
        if (evt.providerCallId && !leg.providerCallId) legData.providerCallId = evt.providerCallId;
        if (evt.providerRequestId && !leg.providerRequestId) legData.providerRequestId = evt.providerRequestId;
        if (t.changed) {
          legData.status = t.status;
          if (t.status === 'RINGING') legData.ringingAt = evt.occurredAt;
          if (t.status === 'ANSWERED') {
            legData.answeredAt = evt.occurredAt;
            legData.everAnswered = true;
          }
        }
        if (evt.type === 'LEG_ENDED') {
          // Billing details may arrive after a system end; record them whenever they are new.
          if (t.changed) {
            legData.endedAt = evt.occurredAt;
            legData.hangupCause = evt.hangupCause ?? null;
            legData.hangupCauseCode = evt.hangupCauseCode ?? null;
            legData.hangupSource = evt.hangupSource ?? null;
          }
          if (evt.durationSeconds != null && leg.durationSeconds == null) legData.durationSeconds = evt.durationSeconds;
          if (evt.billSeconds != null && leg.billSeconds == null) legData.billSeconds = evt.billSeconds;
          if (evt.costMicros != null && leg.costSource !== 'PROVIDER') {
            legData.costMicros = evt.costMicros;
            legData.costCurrency = evt.costCurrency ?? null;
            legData.costSource = 'PROVIDER';
          } else if (t.changed && leg.costMicros == null) {
            // No provider figure (yet): store a clearly-labelled estimate if the tenant configured rates.
            const estimate = await this.estimateCost(tx, call.tenantId, leg.role, evt.billSeconds ?? leg.billSeconds ?? null);
            if (estimate) Object.assign(legData, estimate);
          }
        }
        const updatedLeg = Object.keys(legData).length ? await tx.callLeg.update({ where: { id: leg.id }, data: legData }) : leg;
        const legs = call.legs.map((l) => (l.id === leg.id ? updatedLeg : l));

        if (evt.type === 'LEG_ENDED' && t.changed) {
          await this.recordLegUsage(tx, call, updatedLeg);
          if (call.provider === 'PLIVO' && updatedLeg.costSource !== 'PROVIDER' && updatedLeg.providerCallId) effects.push({ kind: 'FETCH_CDR', legId: leg.id });
        }

        let countedAsAttempt = call.countedAsAttempt;
        if (leg.role === 'CUSTOMER' && t.changed && evt.source !== 'system' && !countedAsAttempt) {
          countedAsAttempt = (await this.markAttempt(tx, call)) || countedAsAttempt;
        }

        const agentLeg = legs.find((l) => l.role === 'AGENT') ?? null;
        const customerLeg = legs.find((l) => l.role === 'CUSTOMER') ?? null;
        const snap = (l: CallLeg | null) => (l ? { status: l.status, answered: l.everAnswered } : null);
        const next = deriveCallStatus(call.status, snap(agentLeg), snap(customerLeg));
        const callData: Prisma.CallUpdateInput = { lastEventAt: new Date() };
        if (t.changed && leg.role === 'AGENT' && t.status === 'ANSWERED') callData.agentAnsweredAt = evt.occurredAt;
        if (t.changed && leg.role === 'CUSTOMER' && t.status === 'RINGING') callData.customerRingingAt = evt.occurredAt;
        if (t.changed && leg.role === 'CUSTOMER' && t.status === 'ANSWERED') callData.customerAnsweredAt = evt.occurredAt;
        Object.assign(callData, this.costTotals(legs));

        if (next !== call.status) {
          callData.status = next;
          callData.statusChangedAt = new Date();
          if (next === 'AGENT_CONNECTED' && !customerLeg) {
            await tx.callLeg.create({
              data: { tenantId: call.tenantId, callId: call.id, role: 'CUSTOMER', provider: call.provider, toAddress: call.toNumberE164, fromNumber: call.fromNumber, status: 'QUEUED' },
            });
            effects.push({ kind: 'START_CUSTOMER_LEG' });
            effects.push({ kind: 'AGENT', transition: await this.agents.set(tx, { tenantId: call.tenantId, membershipId: call.membershipId, status: 'ON_CALL', currentCallId: call.id }) });
          }
          if (next === 'CONNECTED') {
            await tx.leadActivity.create({ data: { tenantId: call.tenantId, leadId: call.leadId, type: 'CALL_CONNECTED', actorMembershipId: call.membershipId, data: { callId: call.id } } });
          }
          if (isTerminalCall(next)) {
            const endedAt = evt.occurredAt;
            const answeredAt = (callData.customerAnsweredAt as Date | undefined) ?? call.customerAnsweredAt;
            callData.endedAt = endedAt;
            callData.talkSeconds = answeredAt ? Math.max(0, Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000)) : null;
            const failedLeg = customerLeg && isTerminalLeg(customerLeg.status) ? customerLeg : agentLeg;
            callData.hangupCause = failedLeg?.hangupCause ?? null;
            callData.hangupSource = failedLeg?.hangupSource ?? null;
            callData.failureReason = this.failureReason(next, call, customerLeg, failedLeg);
            await tx.call.update({ where: { id: call.id }, data: callData });
            await this.finalize(tx, { ...call, ...(callData as Partial<Call>), countedAsAttempt, status: next } as Call, next, effects);
            await markProcessed(t.changed ? undefined : `ignored: ${t.ignoredReason}`);
            snapshot = await tx.call.findUnique({ where: { id: call.id }, include: { legs: true } });
            return;
          }
        }
        await tx.call.update({ where: { id: call.id }, data: callData });
        await markProcessed(t.changed ? undefined : `ignored: ${t.ignoredReason}`);
        snapshot = await tx.call.findUnique({ where: { id: call.id }, include: { legs: true } });
      },
      { timeout: 15_000 },
    );
    if (snapshot) await this.runEffects(snapshot, effects);
  }

  private failureReason(status: CallStatus, call: Call, customer: CallLeg | null, ended: CallLeg | null): string | null {
    if (status === 'FAILED') {
      if (ended?.hangupCause?.startsWith('provider_error')) return 'provider_error';
      if (ended?.hangupCause === 'COMPLIANCE_BLOCK') return 'compliance_block';
      if (!customer) return 'agent_unreachable';
      return 'customer_leg_failed';
    }
    if (status === 'CANCELLED') return call.countedAsAttempt ? 'agent_hung_up_before_answer' : 'cancelled_before_dial';
    return null;
  }

  private costTotals(legs: CallLeg[]): Prisma.CallUpdateInput {
    const billed = legs.filter((l) => l.billSeconds != null);
    const costed = legs.filter((l) => l.costMicros != null);
    const currencies = new Set(costed.map((l) => l.costCurrency));
    return {
      billableSeconds: billed.length ? billed.reduce((s, l) => s + (l.billSeconds ?? 0), 0) : null,
      costMicros: costed.length && currencies.size === 1 ? costed.reduce((s, l) => s + (l.costMicros ?? 0n), 0n) : null,
      costCurrency: currencies.size === 1 ? [...currencies][0] : null,
      costSource: costed.length === 0 ? 'NONE' : costed.every((l) => l.costSource === 'PROVIDER') ? 'PROVIDER' : 'ESTIMATE',
    };
  }

  /** Terminal call: release or hold the lead, move the agent, auto-wrap unanswered calls. */
  private async finalize(tx: Tx, call: Call, status: CallStatus, effects: Effect[]): Promise<void> {
    const { settings } = await this.settings.get(call.tenantId, tx);
    effects.push({ kind: 'HANGUP_ACTIVE_LEGS', reason: `call ${status.toLowerCase()}` });
    if (!call.countedAsAttempt) {
      // The customer was never dialled: return the lead to the queue without using an attempt.
      if (call.queueItemId) {
        await tx.queueItem.updateMany({
          where: { id: call.queueItemId, tenantId: call.tenantId, state: 'IN_PROGRESS' },
          data: { state: 'WAITING', availableAt: new Date(), reservedByMembershipId: null, reservedAt: null },
        });
      }
      await tx.call.update({ where: { id: call.id }, data: { wrapUpStatus: 'NOT_REQUIRED' } });
      const reason =
        call.failureReason === 'compliance_block'
          ? null
          : call.failureReason === 'provider_error'
            ? 'The telephony provider rejected the call. Check Settings → Integrations, then resume.'
            : status === 'FAILED'
              ? 'Your line did not answer. Check your browser audio or phone, then resume.'
              : 'Call ended before the customer was dialled.';
      effects.push({
        kind: 'AGENT',
        transition: await this.agents.set(tx, { tenantId: call.tenantId, membershipId: call.membershipId, status: reason ? 'PAUSED' : 'READY', pauseReason: reason, currentCallId: null }),
      });
      await tx.leadActivity.create({ data: { tenantId: call.tenantId, leadId: call.leadId, type: 'CALL_NOT_PLACED', actorMembershipId: call.membershipId, data: { callId: call.id, reason: call.failureReason } } });
      return;
    }
    const auto = suggestedOutcomeFor(status);
    if (settings.calling.autoWrapUpUnanswered && auto) {
      const result = await this.wrapUp.applyOutcome(tx, { call, outcomeCode: auto, notes: null, callbackAt: null, callbackAssigneeId: null, recordedBy: 'SYSTEM', next: 'READY', actorMembershipId: null });
      effects.push(...result);
      return;
    }
    effects.push({ kind: 'AGENT', transition: await this.agents.set(tx, { tenantId: call.tenantId, membershipId: call.membershipId, status: 'WRAP_UP', currentCallId: call.id }) });
  }

  private async recordLegUsage(tx: Tx, call: Call, leg: CallLeg): Promise<void> {
    if (leg.billSeconds != null && leg.billSeconds > 0) {
      await tx.usageLedgerEntry.upsert({
        where: { kind_sourceType_sourceId: { kind: 'VOICE_LEG_SECONDS', sourceType: 'call_leg', sourceId: leg.id } },
        create: { tenantId: call.tenantId, kind: 'VOICE_LEG_SECONDS', quantity: BigInt(leg.billSeconds), isEstimate: call.isSimulated, sourceType: 'call_leg', sourceId: leg.id, occurredAt: leg.endedAt ?? new Date() },
        update: { quantity: BigInt(leg.billSeconds) },
      });
    }
    if (leg.costMicros != null) await this.upsertCost(tx, call.tenantId, leg.id, leg.costMicros, leg.costCurrency, leg.costSource !== 'PROVIDER', leg.endedAt ?? new Date());
  }

  /** Tenant-configured per-minute estimate (minor units → micro-units). Never presented as an invoice. */
  private async estimateCost(tx: Tx, tenantId: string, role: string, billSeconds: number | null): Promise<Prisma.CallLegUpdateInput | null> {
    if (!billSeconds || billSeconds <= 0 || role === 'SUPERVISOR') return null;
    const { settings } = await this.settings.get(tenantId, tx);
    const rate = role === 'AGENT' ? settings.costEstimates.agentLegPerMinuteMinor : settings.costEstimates.customerLegPerMinuteMinor;
    if (rate == null) return null;
    const minutes = Math.ceil(billSeconds / 60);
    return { costMicros: BigInt(minutes) * BigInt(rate) * 10_000n, costCurrency: settings.costEstimates.currency, costSource: 'ESTIMATE' };
  }

  async upsertCost(tx: Tx, tenantId: string, legId: string, micros: bigint, currency: string | null, isEstimate: boolean, occurredAt: Date) {
    await tx.usageLedgerEntry.upsert({
      where: { kind_sourceType_sourceId: { kind: 'VOICE_COST', sourceType: 'call_leg', sourceId: legId } },
      create: { tenantId, kind: 'VOICE_COST', quantity: 1n, amountMicros: micros, currency, isEstimate, sourceType: 'call_leg', sourceId: legId, occurredAt },
      update: { amountMicros: micros, currency, isEstimate },
    });
  }

  private async applyRecording(tx: Tx, call: Call, evt: ProviderEvent): Promise<void> {
    if (!evt.recording) return;
    const { settings } = await this.settings.get(call.tenantId, tx);
    const retentionUntil = new Date(Date.now() + settings.recording.retentionDays * 86400_000);
    await tx.recording.upsert({
      where: { provider_providerRecordingId: { provider: call.provider, providerRecordingId: evt.recording.providerRecordingId } },
      create: {
        tenantId: call.tenantId,
        callId: call.id,
        provider: call.provider,
        providerRecordingId: evt.recording.providerRecordingId,
        status: 'AVAILABLE',
        durationSeconds: evt.recording.durationSeconds,
        format: evt.recording.format,
        providerUrl: evt.recording.url,
        retentionUntil,
      },
      update: { status: 'AVAILABLE', durationSeconds: evt.recording.durationSeconds ?? undefined, providerUrl: evt.recording.url ?? undefined },
    });
    if (evt.recording.durationSeconds) {
      await tx.usageLedgerEntry.upsert({
        where: { kind_sourceType_sourceId: { kind: 'RECORDING_SECONDS', sourceType: 'recording', sourceId: evt.recording.providerRecordingId } },
        create: { tenantId: call.tenantId, kind: 'RECORDING_SECONDS', quantity: BigInt(evt.recording.durationSeconds), sourceType: 'recording', sourceId: evt.recording.providerRecordingId, occurredAt: new Date() },
        update: {},
      });
    }
  }

  async runEffects(call: CallWithLegs, effects: Effect[]): Promise<void> {
    for (const e of effects) {
      try {
        if (e.kind === 'START_CUSTOMER_LEG') await this.jobs.add('dialer.customer-leg', { tenantId: call.tenantId, callId: call.id }, { jobId: `cust-${call.id}`, attempts: 1 });
        else if (e.kind === 'HANGUP_ACTIVE_LEGS') {
          if (call.legs.some((l) => !isTerminalLeg(l.status))) await this.jobs.add('dialer.hangup', { tenantId: call.tenantId, callId: call.id, reason: e.reason }, { jobId: `hangup-${call.id}-${Date.now()}`, attempts: 4 });
        } else if (e.kind === 'FETCH_CDR') await this.jobs.add('dialer.fetch-cdr', { tenantId: call.tenantId, legId: e.legId }, { jobId: `cdr-${e.legId}`, delay: 60_000, attempts: 6, backoff: { type: 'exponential', delay: 60_000 } });
        else if (e.kind === 'AGENT') await this.agents.publish(e.transition);
        else if (e.kind === 'FOLLOW_UP') await this.wrapUp.afterCommit(call.tenantId, e.callId, e.outcomeCode);
      } catch (err) {
        this.logger.error(`Effect ${e.kind} for call ${call.id} failed: ${(err as Error).message}`);
      }
    }
    await this.publishCall(call);
  }

  async publishCall(call: CallWithLegs): Promise<void> {
    const payload: CallUpdatedPayload = {
      callId: call.id,
      membershipId: call.membershipId,
      leadId: call.leadId,
      status: call.status,
      isSimulated: call.isSimulated,
      legs: call.legs.map((l) => ({ role: l.role, status: l.status })),
      customerAnsweredAt: call.customerAnsweredAt?.toISOString() ?? null,
      endedAt: call.endedAt?.toISOString() ?? null,
      failureReason: call.failureReason,
      wrapUpStatus: call.wrapUpStatus,
    };
    await Promise.all([
      this.realtime.toMembership(call.membershipId, RealtimeEvent.CALL_UPDATED, payload),
      this.realtime.toSupervisors(call.tenantId, RealtimeEvent.CALL_UPDATED, payload),
    ]);
  }

  static isActive(status: CallStatus): boolean {
    return ACTIVE.includes(status);
  }
}
