import { Injectable } from '@nestjs/common';
import { RealtimeEvent, type AgentStatePayload, type AgentStatus } from '@crm/shared';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { RealtimeService } from '../../infra/realtime/realtime.service';

export interface AgentTransition {
  membershipId: string;
  tenantId: string;
  status: AgentStatus;
  pauseReason: string | null;
  currentCallId: string | null;
  statusChangedAt: Date;
}

/** Agent availability state with history (for productivity reports) and realtime fan-out. */
@Injectable()
export class AgentStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Lock and return the agent state row inside a transaction. */
  async lock(tx: Tx, tenantId: string, membershipId: string) {
    await tx.$queryRaw`SELECT "membershipId" FROM agent_states WHERE "membershipId" = ${membershipId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
    return tx.agentState.findFirst({ where: { membershipId, tenantId } });
  }

  /**
   * Move an agent to a new status inside the caller's transaction. Writes a history row whenever
   * the status changes. Returns the transition to publish after commit.
   */
  async set(
    tx: Tx,
    input: { tenantId: string; membershipId: string; status: AgentStatus; pauseReason?: string | null; currentCallId?: string | null },
  ): Promise<AgentTransition> {
    const now = new Date();
    const current = await tx.agentState.findFirst({ where: { membershipId: input.membershipId, tenantId: input.tenantId } });
    const pauseReason = input.status === 'PAUSED' || input.status === 'OFFLINE' ? (input.pauseReason ?? null) : null;
    const currentCallId = input.currentCallId === undefined ? (current?.currentCallId ?? null) : input.currentCallId;
    const changed = !current || current.status !== input.status;
    if (!current) {
      await tx.agentState.create({ data: { membershipId: input.membershipId, tenantId: input.tenantId, status: input.status, pauseReason, currentCallId, statusChangedAt: now } });
    } else {
      await tx.agentState.update({
        where: { membershipId: input.membershipId, tenantId: input.tenantId },
        data: { status: input.status, pauseReason, currentCallId, ...(changed ? { statusChangedAt: now } : {}), version: { increment: 1 } },
      });
    }
    if (changed) {
      await tx.agentStatusHistory.updateMany({ where: { tenantId: input.tenantId, membershipId: input.membershipId, endedAt: null }, data: { endedAt: now } });
      await tx.agentStatusHistory.create({ data: { tenantId: input.tenantId, membershipId: input.membershipId, status: input.status, reason: pauseReason, startedAt: now } });
    }
    return { membershipId: input.membershipId, tenantId: input.tenantId, status: input.status, pauseReason, currentCallId, statusChangedAt: changed ? now : (current?.statusChangedAt ?? now) };
  }

  async publish(t: AgentTransition): Promise<void> {
    const payload: AgentStatePayload = {
      membershipId: t.membershipId,
      status: t.status,
      pauseReason: t.pauseReason,
      currentCallId: t.currentCallId,
      statusChangedAt: t.statusChangedAt.toISOString(),
    };
    await Promise.all([
      this.realtime.toMembership(t.membershipId, RealtimeEvent.AGENT_STATE, payload),
      this.realtime.toSupervisors(t.tenantId, RealtimeEvent.AGENT_STATE, payload),
    ]);
  }
}
