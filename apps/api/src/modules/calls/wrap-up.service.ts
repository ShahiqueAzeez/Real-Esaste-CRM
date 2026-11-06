import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { decideRetry, isTerminalCall, retryKeyForOutcome, type CallStatus, type OutcomeSubmit } from '@crm/shared';
import type { Call } from '@prisma/client';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { JobsService } from '../../infra/jobs/jobs.module';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AgentStateService } from '../agent/agent-state.service';
import { AuditService } from '../audit/audit.service';
import { ComplianceService } from '../compliance/compliance.service';
import { ScopeService, TenantSettingsService } from '../org/org-core.service';
import { TelephonyRegistry } from '../telephony/registry.service';
import { CallLifecycleService, type Effect } from './call-lifecycle.service';

export interface ApplyOutcomeInput {
  call: Call;
  outcomeCode: string;
  notes: string | null;
  callbackAt: Date | null;
  callbackAssigneeId: string | null;
  recordedBy: 'AGENT' | 'SYSTEM' | 'SUPERVISOR';
  next: 'READY' | 'PAUSED';
  actorMembershipId: string | null;
}

const CALLBACK_PRIORITY = 50;

@Injectable()
export class WrapUpService {
  private readonly logger = new Logger('WrapUp');
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: TenantSettingsService,
    private readonly compliance: ComplianceService,
    private readonly agents: AgentStateService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly scope: ScopeService,
    private readonly registry: TelephonyRegistry,
    private readonly moduleRef: ModuleRef,
    @Inject(forwardRef(() => CallLifecycleService)) private readonly lifecycle: CallLifecycleService,
  ) {}

  /**
   * Record the outcome and decide what happens to the lead next. Runs inside the caller's
   * transaction (auto wrap-up runs inside event processing). Returns post-commit effects.
   */
  async applyOutcome(tx: Tx, input: ApplyOutcomeInput): Promise<Effect[]> {
    const { call } = input;
    const effects: Effect[] = [];
    const def = await tx.outcomeDefinition.findFirst({ where: { tenantId: call.tenantId, code: input.outcomeCode, active: true } });
    if (!def) throw Errors.badRequest('UNKNOWN_OUTCOME', 'Choose a valid outcome');
    const { settings, timezone } = await this.settings.get(call.tenantId, tx);
    const lead = await tx.lead.findFirstOrThrow({ where: { id: call.leadId, tenantId: call.tenantId } });
    const item = call.queueItemId ? await tx.queueItem.findFirst({ where: { id: call.queueItemId, tenantId: call.tenantId } }) : null;
    const now = new Date();

    await tx.callOutcome.create({
      data: {
        tenantId: call.tenantId,
        callId: call.id,
        leadId: call.leadId,
        membershipId: call.membershipId,
        outcomeCode: def.code,
        outcomeLabel: def.label,
        category: def.category,
        notes: input.notes,
        callbackAt: input.callbackAt,
        recordedBy: input.recordedBy,
      },
    });
    if (input.notes) {
      await tx.leadNote.create({ data: { tenantId: call.tenantId, leadId: call.leadId, authorMembershipId: input.actorMembershipId ?? call.membershipId, callId: call.id, body: input.notes } });
    }

    let nextCallbackAt: Date | null = null;
    let queueDecision: Record<string, unknown> = {};
    if (def.suppressReason) {
      await this.compliance.suppress(tx, { tenantId: call.tenantId, phoneE164: lead.phoneE164, channel: 'ALL', reason: def.suppressReason, source: `call_outcome:${def.code}`, membershipId: input.actorMembershipId ?? call.membershipId });
    }

    // Any open callback for this lead is fulfilled by this call.
    await tx.callback.updateMany({
      where: { tenantId: call.tenantId, leadId: call.leadId, status: 'PENDING', dueAt: { lte: new Date(now.getTime() + 60 * 60_000) } },
      data: { status: 'COMPLETED', completedAt: now, completedCallId: call.id },
    });

    if (item) {
      if (def.isFinal || def.suppressReason) {
        queueDecision = { state: 'DONE', doneReason: `OUTCOME_${def.code}` };
      } else if (def.retryBehavior === 'CALLBACK') {
        if (!input.callbackAt) throw Errors.badRequest('CALLBACK_REQUIRED', 'Choose a callback time');
        const assignee = input.callbackAssigneeId ?? call.membershipId;
        const cb = await tx.callback.create({
          data: { tenantId: call.tenantId, leadId: call.leadId, sourceCallId: call.id, assignedMembershipId: assignee, createdByMembershipId: input.actorMembershipId ?? call.membershipId, dueAt: input.callbackAt, notes: input.notes },
        });
        nextCallbackAt = input.callbackAt;
        queueDecision = { state: 'WAITING', availableAt: input.callbackAt, isCallback: true, callbackId: cb.id, assignedMembershipId: assignee, priority: Math.max(item.priority, CALLBACK_PRIORITY), doneReason: null };
        const remindAt = input.callbackAt.getTime() - 10 * 60_000;
        await this.jobs.add('callbacks.reminder', { tenantId: call.tenantId, callbackId: cb.id }, { jobId: `cb-remind-${cb.id}`, delay: Math.max(0, remindAt - Date.now()), attempts: 3 });
      } else if (def.retryBehavior === 'RETRY') {
        const decision = decideRetry({ key: retryKeyForOutcome(def.code), attemptsMade: item.attempts, now, policy: settings.retry, callingHours: settings.callingHours, timeZone: timezone });
        queueDecision =
          decision.action === 'RETRY'
            ? { state: 'WAITING', availableAt: decision.at, isCallback: false, callbackId: null, assignedMembershipId: settings.leads.strictOwnership ? lead.assignedMembershipId : null, doneReason: null }
            : { state: 'DONE', doneReason: decision.reason };
        await tx.leadActivity.create({
          data: {
            tenantId: call.tenantId,
            leadId: call.leadId,
            type: decision.action === 'RETRY' ? 'RETRY_SCHEDULED' : 'RETRY_STOPPED',
            data: decision.action === 'RETRY' ? { at: decision.at.toISOString(), delayMinutes: decision.delayMinutes, attemptsMade: item.attempts } : { reason: decision.reason, attemptsMade: item.attempts },
          },
        });
      } else {
        queueDecision = { state: 'DONE', doneReason: `OUTCOME_${def.code}` };
      }
      await tx.queueItem.update({ where: { id: item.id, tenantId: call.tenantId }, data: { ...queueDecision, reservedByMembershipId: null, reservedAt: null } });
    }

    const newStatus = def.leadStatus ?? (lead.status === 'NEW' ? 'CONTACTED' : lead.status);
    await tx.lead.update({
      where: { id: lead.id, tenantId: call.tenantId },
      data: { status: def.suppressReason === 'DO_NOT_CALL' || def.suppressReason === 'OPT_OUT' ? 'DO_NOT_CALL' : newStatus, lastCallOutcome: def.code, nextCallbackAt },
    });
    await tx.leadActivity.create({
      data: { tenantId: call.tenantId, leadId: call.leadId, type: 'OUTCOME', actorMembershipId: input.actorMembershipId, data: { callId: call.id, code: def.code, label: def.label, recordedBy: input.recordedBy } },
    });
    await tx.call.update({ where: { id: call.id, tenantId: call.tenantId }, data: { wrapUpStatus: input.recordedBy === 'SUPERVISOR' ? 'RECOVERED' : 'DONE' } });

    const state = await tx.agentState.findFirst({ where: { membershipId: call.membershipId, tenantId: call.tenantId } });
    if (state && (state.currentCallId === call.id || state.status === 'WRAP_UP' || state.status === 'ON_CALL' || state.status === 'DIALING')) {
      const pauseReason = input.recordedBy === 'SUPERVISOR' ? 'A supervisor closed your last call.' : input.next === 'PAUSED' ? 'Paused after call' : null;
      effects.push({
        kind: 'AGENT',
        transition: await this.agents.set(tx, { tenantId: call.tenantId, membershipId: call.membershipId, status: input.recordedBy === 'SUPERVISOR' ? 'PAUSED' : input.next, pauseReason, currentCallId: null }),
      });
    }
    effects.push({ kind: 'FOLLOW_UP', callId: call.id, outcomeCode: def.code });
    return effects;
  }

  private async loadCallForUpdate(tx: Tx, tenantId: string, callId: string): Promise<Call> {
    await tx.$queryRaw`SELECT id FROM calls WHERE id = ${callId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    const call = await tx.call.findFirst({ where: { id: callId, tenantId } });
    if (!call) throw Errors.notFound('Call');
    return call;
  }

  /** Agent submits the wrap-up for their own call. */
  async submit(ctx: RequestContext, callId: string, body: OutcomeSubmit) {
    let effects: Effect[] = [];
    await this.prisma.db.$transaction(
      async (tx) => {
        const call = await this.loadCallForUpdate(tx, ctx.tenantId, callId);
        if (call.membershipId !== ctx.membershipId) throw Errors.forbidden('Only the agent on the call can save its outcome');
        if (!isTerminalCall(call.status as CallStatus)) throw Errors.conflict('CALL_ACTIVE', 'Hang up before saving the outcome');
        if (call.wrapUpStatus !== 'PENDING') throw Errors.conflict('ALREADY_WRAPPED', 'This call already has an outcome');
        const def = await tx.outcomeDefinition.findFirst({ where: { tenantId: ctx.tenantId, code: body.outcomeCode, active: true, selectable: true } });
        if (!def) throw Errors.badRequest('UNKNOWN_OUTCOME', 'Choose a valid outcome');
        if (def.requiresNotes && !body.notes) throw Errors.validation([{ path: 'notes', message: `Notes are required for "${def.label}"` }]);
        let callbackAt: Date | null = null;
        if (def.requiresCallback || def.retryBehavior === 'CALLBACK') {
          if (!body.callbackAt) throw Errors.validation([{ path: 'callbackAt', message: 'Choose a callback time' }]);
          const t = body.callbackAt.getTime();
          if (t < Date.now() + 60_000 || t > Date.now() + 365 * 86400_000) throw Errors.validation([{ path: 'callbackAt', message: 'Choose a time between now and one year ahead' }]);
          callbackAt = body.callbackAt;
        }
        if (body.callbackAssigneeId) {
          const a = await tx.membership.findFirst({ where: { id: body.callbackAssigneeId, tenantId: ctx.tenantId, role: 'AGENT', status: 'ACTIVE' } });
          if (!a) throw Errors.badRequest('INVALID_ASSIGNEE', 'Callbacks can only be assigned to active agents');
        }
        effects = await this.applyOutcome(tx, {
          call,
          outcomeCode: def.code,
          notes: body.notes ?? null,
          callbackAt,
          callbackAssigneeId: body.callbackAssigneeId ?? null,
          recordedBy: 'AGENT',
          next: body.next,
          actorMembershipId: ctx.membershipId,
        });
      },
      { timeout: 15_000 },
    );
    const call = await this.prisma.db.call.findFirstOrThrow({ where: { id: callId, tenantId: ctx.tenantId }, include: { legs: true } });
    await this.lifecycle.runEffects(call, effects);
    return { callId, wrapUpStatus: call.wrapUpStatus };
  }

  /**
   * Documented recovery workflow: a supervisor or admin closes a call whose wrap-up is stuck
   * (agent left, browser crashed) or that never received terminal provider events.
   */
  async recover(ctx: RequestContext, callId: string, notes: string) {
    const where = await this.scope.callWhere(ctx);
    const call = await this.prisma.db.call.findFirst({ where: { AND: [where, { id: callId, tenantId: ctx.tenantId }], tenantId: ctx.tenantId }, include: { legs: true } });
    if (!call) throw Errors.notFound('Call');
    if (!isTerminalCall(call.status as CallStatus)) {
      const staleMs = Date.now() - (call.lastEventAt ?? call.initiatedAt).getTime();
      if (staleMs < 2 * 60_000) throw Errors.conflict('CALL_ACTIVE', 'This call is still receiving updates. Try again in two minutes or ask the agent to hang up.');
      const provider = await this.registry.forCall(call.tenantId, call.provider);
      for (const leg of call.legs.filter((l) => !['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'].includes(l.status))) {
        await provider.hangupLeg({ providerCallId: leg.providerCallId, providerRequestId: leg.providerRequestId, legId: leg.id, callId: call.id, tenantId: call.tenantId, answered: leg.everAnswered }).catch(() => undefined);
        await this.lifecycle.systemEndLeg(call, leg.id, leg.everAnswered ? 'COMPLETED' : 'CANCELLED', 'recovered_by_supervisor');
      }
    }
    let effects: Effect[] = [];
    await this.prisma.db.$transaction(async (tx) => {
      const locked = await this.loadCallForUpdate(tx, ctx.tenantId, callId);
      if (locked.wrapUpStatus !== 'PENDING') return;
      effects = await this.applyOutcome(tx, { call: locked, outcomeCode: 'SYSTEM_RECOVERED', notes, callbackAt: null, callbackAssigneeId: null, recordedBy: 'SUPERVISOR', next: 'PAUSED', actorMembershipId: ctx.membershipId });
    });
    await this.audit.fromCtx(ctx, 'call.recovered', 'call', callId);
    const fresh = await this.prisma.db.call.findFirstOrThrow({ where: { id: callId, tenantId: ctx.tenantId }, include: { legs: true } });
    await this.lifecycle.runEffects(fresh, effects);
    return { callId, wrapUpStatus: fresh.wrapUpStatus, status: fresh.status };
  }

  /** Post-commit follow-ups (WhatsApp confirmations / missed-call messages, if enabled). */
  async afterCommit(tenantId: string, callId: string, outcomeCode: string): Promise<void> {
    try {
      const { WhatsAppService } = await import('../whatsapp/whatsapp.service');
      const wa = this.moduleRef.get(WhatsAppService, { strict: false });
      await wa.followUpForOutcome(tenantId, callId, outcomeCode);
    } catch (err) {
      this.logger.warn(`Follow-up for call ${callId} skipped: ${(err as Error).message}`);
    }
  }
}
