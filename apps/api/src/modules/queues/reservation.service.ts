import { Injectable } from '@nestjs/common';
import type { TenantSettings } from '@crm/shared';
import { Prisma } from '@prisma/client';
import type { Tx } from '../../infra/prisma/prisma.service';

export interface ReservedItem {
  id: string;
  leadId: string;
  queueId: string;
  attempts: number;
  isCallback: boolean;
}

/**
 * Atomic next-lead reservation. `FOR UPDATE SKIP LOCKED` lets many agents reserve concurrently
 * without ever receiving the same queue item; the eligibility rules (consent, suppression, final
 * statuses, attempts, active calls, queue membership, ownership) are part of the query.
 * Enum literals are inlined (constants), all user-controlled values are bound parameters.
 */
@Injectable()
export class ReservationService {
  async reserveNext(tx: Tx, input: { tenantId: string; membershipId: string; settings: TenantSettings; now: Date; excludeIds?: string[] }): Promise<ReservedItem | null> {
    const exclude = input.excludeIds?.length ? Prisma.sql`AND qi.id NOT IN (${Prisma.join(input.excludeIds.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
    const consentClause = input.settings.consent.requireConsentForCalls ? Prisma.sql`AND l."consentStatus" = 'GRANTED'` : Prisma.sql`AND l."consentStatus" <> 'REVOKED'`;
    const rows = await tx.$queryRaw<ReservedItem[]>`
      SELECT qi.id, qi."leadId", qi."queueId", qi.attempts, qi."isCallback"
      FROM queue_items qi
      JOIN leads l ON l.id = qi."leadId" AND l."tenantId" = qi."tenantId"
      JOIN queues q ON q.id = qi."queueId" AND q."tenantId" = qi."tenantId"
      JOIN queue_members qm ON qm."queueId" = qi."queueId" AND qm."membershipId" = ${input.membershipId}::uuid
      WHERE qi."tenantId" = ${input.tenantId}::uuid
        AND qi.state = 'WAITING'
        AND qi."availableAt" <= ${input.now}
        AND q.active = true
        AND qi.attempts < ${input.settings.retry.maxAttempts}
        AND (qi."assignedMembershipId" IS NULL OR qi."assignedMembershipId" = ${input.membershipId}::uuid)
        AND l.status NOT IN ('NOT_INTERESTED', 'CONVERTED', 'INVALID', 'DO_NOT_CALL', 'CLOSED')
        ${consentClause}
        AND NOT EXISTS (
          SELECT 1 FROM suppression_entries s
          WHERE s."tenantId" = qi."tenantId" AND s."phoneE164" = l."phoneE164" AND s.channel IN ('ALL', 'VOICE')
            AND (s."expiresAt" IS NULL OR s."expiresAt" > ${input.now})
        )
        AND NOT EXISTS (
          SELECT 1 FROM calls c
          WHERE c."tenantId" = qi."tenantId" AND c."leadId" = qi."leadId"
            AND c.status IN ('INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED')
        )
        ${exclude}
      ORDER BY
        CASE WHEN qi."isCallback" AND qi."assignedMembershipId" = ${input.membershipId}::uuid THEN 0 WHEN qi."isCallback" THEN 1 ELSE 2 END,
        qi.priority DESC,
        qi."availableAt" ASC,
        qi."createdAt" ASC
      LIMIT 1
      FOR UPDATE OF qi SKIP LOCKED`;
    const row = rows[0];
    if (!row) return null;
    await tx.queueItem.update({
      where: { id: row.id, tenantId: input.tenantId },
      data: { state: 'IN_PROGRESS', reservedByMembershipId: input.membershipId, reservedAt: input.now },
    });
    return row;
  }

  /** Earliest time a waiting item becomes available to this agent (for "next lead at" hints). */
  async nextAvailableAt(tx: Tx, tenantId: string, membershipId: string): Promise<Date | null> {
    const rows = await tx.$queryRaw<{ at: Date | null }[]>`
      SELECT MIN(qi."availableAt") AS at
      FROM queue_items qi
      JOIN queue_members qm ON qm."queueId" = qi."queueId" AND qm."membershipId" = ${membershipId}::uuid
      WHERE qi."tenantId" = ${tenantId}::uuid AND qi.state = 'WAITING'
        AND (qi."assignedMembershipId" IS NULL OR qi."assignedMembershipId" = ${membershipId}::uuid)`;
    return rows[0]?.at ?? null;
  }
}
