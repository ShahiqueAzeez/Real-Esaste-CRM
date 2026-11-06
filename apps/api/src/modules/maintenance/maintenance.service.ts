import { Injectable, Logger } from '@nestjs/common';
import { ACTIVE_CALL_STATUSES, isTerminalLeg, parseTenantSettings } from '@crm/shared';
import { JobsService } from '../../infra/jobs/jobs.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../../infra/storage/storage.service';
import { AgentStateService } from '../agent/agent-state.service';
import { AuditService } from '../audit/audit.service';
import { CallLifecycleService } from '../calls/call-lifecycle.service';
import { TelephonyRegistry } from '../telephony/registry.service';

const HEARTBEAT_TIMEOUT_MS = 90_000;
const STUCK_AFTER_MS = 3 * 60_000;

/** Periodic safety nets. Each sweep is idempotent and safe to run on several workers. */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Maintenance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentStateService,
    private readonly lifecycle: CallLifecycleService,
    private readonly registry: TelephonyRegistry,
    private readonly jobs: JobsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /** Agents whose browser stopped sending heartbeats go Offline (never during a call). */
  async staleAgents(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - HEARTBEAT_TIMEOUT_MS);
    const stale = await this.prisma.system.agentState.findMany({
      where: { status: { in: ['READY', 'PAUSED'] }, OR: [{ lastHeartbeatAt: { lt: cutoff } }, { lastHeartbeatAt: null, statusChangedAt: { lt: cutoff } }] },
      select: { membershipId: true, tenantId: true },
    });
    for (const a of stale) {
      const t = await this.prisma.system.$transaction(async (tx) => {
        const s = await this.agents.lock(tx, a.tenantId, a.membershipId);
        if (!s || !['READY', 'PAUSED'].includes(s.status)) return null;
        if (s.lastHeartbeatAt && s.lastHeartbeatAt >= cutoff) return null;
        return this.agents.set(tx, { tenantId: a.tenantId, membershipId: a.membershipId, status: 'OFFLINE', pauseReason: 'Connection lost', currentCallId: null });
      });
      if (t) await this.agents.publish(t);
    }
    return stale.length;
  }

  /** Reconcile calls that stopped receiving provider events (lost webhooks, crashed browser). */
  async stuckCalls(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
    const calls = await this.prisma.system.call.findMany({
      where: { status: { in: ACTIVE_CALL_STATUSES }, OR: [{ lastEventAt: { lt: cutoff } }, { lastEventAt: null, initiatedAt: { lt: cutoff } }] },
      include: { legs: true, tenant: { select: { settings: true } } },
      take: 200,
    });
    for (const call of calls) {
      const settings = parseTenantSettings(call.tenant.settings);
      const maxMs = (settings.calling.maxCallMinutes + 5) * 60_000;
      const tooLong = now.getTime() - call.initiatedAt.getTime() > maxMs;
      const provider = await this.registry.forCall(call.tenantId, call.provider).catch(() => null);
      for (const leg of call.legs.filter((l) => !isTerminalLeg(l.status))) {
        try {
          if (provider?.kind === 'PLIVO' && leg.providerCallId) {
            const cdr = await provider.getCallDetails(leg.providerCallId);
            if (cdr) {
              await this.lifecycle.ingest({
                provider: 'PLIVO',
                source: 'reconciler',
                tenantId: call.tenantId,
                callId: call.id,
                legId: leg.id,
                type: 'LEG_ENDED',
                dedupeKey: `reconcile-end:${leg.id}`,
                occurredAt: now,
                endStatus: cdr.answered ? 'COMPLETED' : 'NO_ANSWER',
                billSeconds: cdr.billSeconds,
                durationSeconds: cdr.durationSeconds,
                costMicros: cdr.costMicros,
                costCurrency: cdr.currency,
                hangupCause: cdr.hangupCause ?? 'reconciled_from_cdr',
                hangupSource: cdr.hangupSource,
                raw: { reconciled: true },
              });
              continue;
            }
          }
          const answeredLive = leg.status === 'ANSWERED' && !tooLong;
          if (answeredLive) continue; // a long, healthy conversation: leave it alone
          if (provider) {
            await provider.hangupLeg({ providerCallId: leg.providerCallId, providerRequestId: leg.providerRequestId, legId: leg.id, callId: call.id, tenantId: call.tenantId, answered: leg.everAnswered }).catch(() => undefined);
          }
          await this.lifecycle.systemEndLeg(call, leg.id, leg.everAnswered ? 'COMPLETED' : leg.status === 'RINGING' ? 'NO_ANSWER' : 'FAILED', tooLong ? 'max_duration_reached' : 'reconcile_timeout');
        } catch (err) {
          this.logger.warn(`Could not reconcile leg ${leg.id}: ${(err as Error).message}`);
        }
      }
    }
    return calls.length;
  }

  /** Queue items stuck IN_PROGRESS without an active or pending call go back to the queue. */
  async orphanQueueItems(now = new Date()): Promise<number> {
    const rows = await this.prisma.system.$queryRaw<{ id: string }[]>`
      UPDATE queue_items qi SET state = 'WAITING', "reservedByMembershipId" = NULL, "reservedAt" = NULL, "updatedAt" = now()
      WHERE qi.state = 'IN_PROGRESS' AND qi."reservedAt" < ${new Date(now.getTime() - 10 * 60_000)}
        AND NOT EXISTS (
          SELECT 1 FROM calls c WHERE c."queueItemId" = qi.id
            AND (c.status IN ('INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED') OR c."wrapUpStatus" = 'PENDING')
        )
      RETURNING qi.id`;
    return rows.length;
  }

  /** Re-enqueue stored provider events that were never processed (e.g. Redis was down). */
  async pendingEvents(now = new Date()): Promise<number> {
    const rows = await this.prisma.system.callEvent.findMany({
      where: { processedAt: null, receivedAt: { lt: new Date(now.getTime() - 30_000) }, attempts: { lt: 10 } },
      select: { id: true },
      take: 500,
    });
    for (const r of rows) await this.jobs.add('call-events.process', { eventId: r.id }, { jobId: `evt-sweep-${r.id}-${Math.floor(now.getTime() / 60_000)}`, attempts: 1 });
    return rows.length;
  }

  /** Recording and lead retention, expired sessions and old outbox rows. */
  async retention(now = new Date()): Promise<{ recordings: number; leads: number }> {
    let recordings = 0;
    const expired = await this.prisma.system.recording.findMany({ where: { status: 'AVAILABLE', retentionUntil: { lt: now } }, take: 500 });
    for (const rec of expired) {
      try {
        const provider = await this.registry.forCall(rec.tenantId, rec.provider);
        await provider.deleteRecording(rec.providerRecordingId);
        await this.prisma.system.recording.update({ where: { id: rec.id }, data: { status: 'DELETED', deletedAt: now, providerUrl: null } });
        await this.audit.log({ tenantId: rec.tenantId, action: 'recording.deleted_by_retention', entityType: 'recording', entityId: rec.id });
        recordings++;
      } catch (err) {
        this.logger.warn(`Retention delete failed for recording ${rec.id}: ${(err as Error).message}`);
      }
    }
    let leads = 0;
    const tenants = await this.prisma.system.tenant.findMany({ select: { id: true, settings: true } });
    for (const t of tenants) {
      const days = parseTenantSettings(t.settings).leads.retentionDays;
      if (!days) continue;
      const cutoff = new Date(now.getTime() - days * 86400_000);
      const res = await this.prisma.system.lead.deleteMany({
        where: {
          tenantId: t.id,
          updatedAt: { lt: cutoff },
          OR: [{ lastCallAt: null }, { lastCallAt: { lt: cutoff } }],
          calls: { none: { status: { in: ACTIVE_CALL_STATUSES } } },
        },
      });
      if (res.count) await this.audit.log({ tenantId: t.id, action: 'lead.deleted_by_retention', metadata: { count: res.count, days } });
      leads += res.count;
    }
    await this.prisma.system.session.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 7 * 86400_000) } } });
    await this.prisma.system.emailOutbox.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400_000) } } });
    const oldImports = await this.prisma.system.leadImportJob.findMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400_000) } }, select: { storageKey: true } });
    for (const i of oldImports) {
      await this.storage.delete(i.storageKey).catch(() => undefined);
      await this.storage.delete(i.storageKey.replace(/\.csv$/, '-errors.csv')).catch(() => undefined);
    }
    return { recordings, leads };
  }

  /** Trial expiry, period end → past due (grace) → suspended. Payments are recorded by the platform team. */
  async subscriptions(now = new Date()): Promise<number> {
    const subs = await this.prisma.system.subscription.findMany({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } });
    let changed = 0;
    for (const s of subs) {
      let next: 'PAST_DUE' | 'SUSPENDED' | null = null;
      const graceEnd = new Date(s.currentPeriodEnd.getTime() + s.graceDays * 86400_000);
      if ((s.status === 'TRIALING' || s.status === 'ACTIVE') && s.currentPeriodEnd < now) next = graceEnd < now ? 'SUSPENDED' : 'PAST_DUE';
      else if (s.status === 'PAST_DUE' && graceEnd < now) next = 'SUSPENDED';
      if (!next) continue;
      await this.prisma.system.subscription.update({ where: { id: s.id }, data: { status: next } });
      await this.audit.log({ tenantId: s.tenantId, action: `subscription.${next.toLowerCase()}`, entityType: 'subscription', entityId: s.id });
      changed++;
    }
    return changed;
  }
}
