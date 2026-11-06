import { Controller, Get, Header, Injectable, Module, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { reportQuerySchema, toCsv } from '@crm/shared';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import type { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { ZQuery } from '../../common/pipes/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QueuesService } from '../queues/queues.service';
import { ScopeService } from '../org/org-core.service';

type Range = z.output<typeof reportQuerySchema>;
const MAX_RANGE_DAYS = 400;
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/**
 * Every figure here is computed from persisted rows. Attempted, answered and connected calls are
 * distinct; provider-reported costs and tenant estimates are reported separately per currency.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly queues: QueuesService,
  ) {}

  private check(range: Range) {
    if (range.to <= range.from) throw Errors.badRequest('INVALID_RANGE', '"to" must be after "from"');
    if ((range.to.getTime() - range.from.getTime()) / 86400_000 > MAX_RANGE_DAYS) throw Errors.badRequest('RANGE_TOO_LARGE', `Choose at most ${MAX_RANGE_DAYS} days`);
  }

  /** SQL fragment restricting calls to the caller's visible agents and optional filters. */
  private async callScope(ctx: RequestContext, range: Range, alias = 'c'): Promise<Prisma.Sql> {
    const visible = await this.scope.visibleAgentIds(ctx);
    const a = Prisma.raw(alias);
    const parts: Prisma.Sql[] = [Prisma.sql`${a}."tenantId" = ${ctx.tenantId}::uuid`, Prisma.sql`${a}."initiatedAt" >= ${range.from}`, Prisma.sql`${a}."initiatedAt" < ${range.to}`];
    if (visible) parts.push(Prisma.sql`${a}."membershipId" IN (${Prisma.join(visible.map((id) => Prisma.sql`${id}::uuid`))})`);
    if (range.membershipId) parts.push(Prisma.sql`${a}."membershipId" = ${range.membershipId}::uuid`);
    if (range.queueId) parts.push(Prisma.sql`${a}."queueId" = ${range.queueId}::uuid`);
    return Prisma.join(parts, ' AND ');
  }

  async overview(ctx: RequestContext, range: Range) {
    this.check(range);
    const where = await this.callScope(ctx, range);
    const [calls] = await this.prisma.db.$queryRaw<
      { initiated: bigint; attempted: bigint; answered: bigint; connected: bigint; talk: bigint | null; avgTalk: number | null; simulated: bigint; agentUnreachable: bigint }[]
    >`
      SELECT COUNT(*) AS initiated,
        COUNT(*) FILTER (WHERE c."countedAsAttempt") AS attempted,
        COUNT(*) FILTER (WHERE c."customerAnsweredAt" IS NOT NULL) AS answered,
        COUNT(*) FILTER (WHERE c."customerAnsweredAt" IS NOT NULL AND c."agentAnsweredAt" IS NOT NULL) AS connected,
        SUM(c."talkSeconds") AS talk,
        AVG(c."talkSeconds") FILTER (WHERE c."talkSeconds" IS NOT NULL) AS "avgTalk",
        COUNT(*) FILTER (WHERE c."isSimulated") AS simulated,
        COUNT(*) FILTER (WHERE c."failureReason" = 'agent_unreachable') AS "agentUnreachable"
      FROM calls c WHERE ${where}`;
    const outcomeRows = await this.prisma.db.$queryRaw<{ code: string; label: string; category: string; count: bigint }[]>`
      SELECT o."outcomeCode" AS code, o."outcomeLabel" AS label, o.category::text AS category, COUNT(*) AS count
      FROM call_outcomes o JOIN calls c ON c.id = o."callId"
      WHERE ${where}
      GROUP BY 1, 2, 3 ORDER BY count DESC`;
    const costs = await this.costs(ctx, range);
    const [leadsTotal, leadsNew, agentStates, queueList, callbacks] = await Promise.all([
      this.prisma.db.lead.count({ where: { tenantId: ctx.tenantId } }),
      this.prisma.db.lead.count({ where: { tenantId: ctx.tenantId, createdAt: { gte: range.from, lt: range.to } } }),
      this.prisma.db.agentState.groupBy({ by: ['status'], where: { tenantId: ctx.tenantId, membership: { status: 'ACTIVE', role: 'AGENT' } }, _count: { _all: true } }),
      this.queues.list(ctx),
      this.callbackStats(ctx, range),
    ]);
    const attempted = n(calls?.attempted);
    const answered = n(calls?.answered);
    return {
      range,
      leads: { total: leadsTotal, createdInRange: leadsNew, eligibleNow: queueList.reduce((s, q) => s + q.counts.eligibleNow, 0) },
      calls: {
        initiated: n(calls?.initiated),
        attempted,
        answered,
        connected: n(calls?.connected),
        answerRate: attempted ? answered / attempted : null,
        talkSeconds: n(calls?.talk),
        averageTalkSeconds: calls?.avgTalk != null ? Math.round(Number(calls.avgTalk)) : null,
        simulated: n(calls?.simulated),
        agentUnreachable: n(calls?.agentUnreachable),
      },
      outcomes: outcomeRows.map((r) => ({ code: r.code, label: r.label, category: r.category, count: n(r.count) })),
      conversions: outcomeRows.filter((r) => r.category === 'CONVERTED').reduce((s, r) => s + n(r.count), 0),
      agents: Object.fromEntries(agentStates.map((s) => [s.status, s._count._all])),
      queues: queueList.map((q) => ({ id: q.id, name: q.name, active: q.active, ...q.counts })),
      callbacks,
      costs,
    };
  }

  async callsByDay(ctx: RequestContext, range: Range, timezone: string) {
    this.check(range);
    const where = await this.callScope(ctx, range);
    const rows = await this.prisma.db.$queryRaw<{ day: string; attempted: bigint; answered: bigint; connected: bigint; unanswered: bigint; talk: bigint | null }[]>`
      SELECT to_char(date_trunc('day', c."initiatedAt" AT TIME ZONE ${timezone}), 'YYYY-MM-DD') AS day,
        COUNT(*) FILTER (WHERE c."countedAsAttempt") AS attempted,
        COUNT(*) FILTER (WHERE c."customerAnsweredAt" IS NOT NULL) AS answered,
        COUNT(*) FILTER (WHERE c."customerAnsweredAt" IS NOT NULL AND c."agentAnsweredAt" IS NOT NULL) AS connected,
        COUNT(*) FILTER (WHERE c."countedAsAttempt" AND c."customerAnsweredAt" IS NULL) AS unanswered,
        SUM(c."talkSeconds") AS talk
      FROM calls c WHERE ${where}
      GROUP BY 1 ORDER BY 1`;
    return rows.map((r) => ({ day: r.day, attempted: n(r.attempted), answered: n(r.answered), connected: n(r.connected), unanswered: n(r.unanswered), talkSeconds: n(r.talk) }));
  }

  async agents(ctx: RequestContext, range: Range) {
    this.check(range);
    const where = await this.callScope(ctx, range);
    const callRows = await this.prisma.db.$queryRaw<{ membershipId: string; attempted: bigint; connected: bigint; talk: bigint | null; positive: bigint; converted: bigint }[]>`
      SELECT c."membershipId",
        COUNT(*) FILTER (WHERE c."countedAsAttempt") AS attempted,
        COUNT(*) FILTER (WHERE c."customerAnsweredAt" IS NOT NULL) AS connected,
        SUM(c."talkSeconds") AS talk,
        COUNT(o.id) FILTER (WHERE o.category IN ('POSITIVE', 'CONVERTED')) AS positive,
        COUNT(o.id) FILTER (WHERE o.category = 'CONVERTED') AS converted
      FROM calls c LEFT JOIN call_outcomes o ON o."callId" = c.id
      WHERE ${where}
      GROUP BY c."membershipId"`;
    const visible = await this.scope.visibleAgentIds(ctx);
    const time = await this.prisma.db.$queryRaw<{ membershipId: string; status: string; seconds: number }[]>`
      SELECT h."membershipId", h.status::text AS status,
        SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(h."endedAt", now()), ${range.to}) - GREATEST(h."startedAt", ${range.from}))))::float AS seconds
      FROM agent_status_history h
      WHERE h."tenantId" = ${ctx.tenantId}::uuid AND h."startedAt" < ${range.to} AND COALESCE(h."endedAt", now()) > ${range.from}
        ${visible ? Prisma.sql`AND h."membershipId" IN (${Prisma.join(visible.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
      GROUP BY 1, 2`;
    const members = await this.prisma.db.membership.findMany({
      where: { tenantId: ctx.tenantId, role: 'AGENT', ...(visible ? { id: { in: visible } } : {}) },
      select: { id: true, status: true, user: { select: { name: true } } },
    });
    const byAgent = new Map(callRows.map((r) => [r.membershipId, r]));
    return members
      .map((m) => {
        const r = byAgent.get(m.id);
        const t = Object.fromEntries(time.filter((x) => x.membershipId === m.id).map((x) => [x.status, Math.round(x.seconds)]));
        const loggedIn = (t.READY ?? 0) + (t.DIALING ?? 0) + (t.ON_CALL ?? 0) + (t.WRAP_UP ?? 0) + (t.PAUSED ?? 0);
        const attempted = n(r?.attempted);
        return {
          membershipId: m.id,
          name: m.user.name,
          active: m.status === 'ACTIVE',
          attempted,
          connected: n(r?.connected),
          talkSeconds: n(r?.talk),
          averageTalkSeconds: n(r?.connected) ? Math.round(n(r?.talk) / n(r?.connected)) : null,
          positiveOutcomes: n(r?.positive),
          conversions: n(r?.converted),
          secondsByStatus: t,
          loggedInSeconds: loggedIn,
          callsPerHour: loggedIn > 0 ? Math.round((attempted / (loggedIn / 3600)) * 10) / 10 : null,
        };
      })
      .sort((a, b) => b.attempted - a.attempted);
  }

  async callbackStats(ctx: RequestContext, range: Range) {
    const visible = await this.scope.visibleAgentIds(ctx);
    const rows = await this.prisma.db.$queryRaw<{ scheduled: bigint; completed: bigint; completedOnTime: bigint; cancelled: bigint; overdue: bigint }[]>`
      SELECT COUNT(*) AS scheduled,
        COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND "completedAt" <= "dueAt" + interval '30 minutes') AS "completedOnTime",
        COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
        COUNT(*) FILTER (WHERE status = 'PENDING' AND "dueAt" < now()) AS overdue
      FROM callbacks
      WHERE "tenantId" = ${ctx.tenantId}::uuid AND "dueAt" >= ${range.from} AND "dueAt" < ${range.to}
        ${visible ? Prisma.sql`AND "assignedMembershipId" IN (${Prisma.join(visible.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}`;
    const r = rows[0];
    return { scheduled: n(r?.scheduled), completed: n(r?.completed), completedOnTime: n(r?.completedOnTime), cancelled: n(r?.cancelled), overdue: n(r?.overdue) };
  }

  /** Usage and cost. Provider-reported and estimated figures are kept apart and never summed together. */
  async costs(ctx: RequestContext, range: Range) {
    const rows = await this.prisma.db.$queryRaw<{ kind: string; currency: string | null; isEstimate: boolean; quantity: bigint; micros: bigint | null }[]>`
      SELECT kind::text AS kind, currency, "isEstimate", SUM(quantity) AS quantity, SUM("amountMicros") AS micros
      FROM usage_ledger_entries
      WHERE "tenantId" = ${ctx.tenantId}::uuid AND "occurredAt" >= ${range.from} AND "occurredAt" < ${range.to}
      GROUP BY 1, 2, 3`;
    const voiceCost = rows.filter((r) => r.kind === 'VOICE_COST');
    return {
      voiceSeconds: rows.filter((r) => r.kind === 'VOICE_LEG_SECONDS').reduce((s, r) => s + n(r.quantity), 0),
      providerReported: voiceCost.filter((r) => !r.isEstimate).map((r) => ({ currency: r.currency, amount: n(r.micros) / 1_000_000 })),
      estimated: voiceCost.filter((r) => r.isEstimate).map((r) => ({ currency: r.currency, amount: n(r.micros) / 1_000_000 })),
      whatsappMessages: rows.filter((r) => r.kind === 'WHATSAPP_MESSAGE').reduce((s, r) => s + n(r.quantity), 0),
      leadsImported: rows.filter((r) => r.kind === 'LEAD_IMPORT').reduce((s, r) => s + n(r.quantity), 0),
      recordingSeconds: rows.filter((r) => r.kind === 'RECORDING_SECONDS').reduce((s, r) => s + n(r.quantity), 0),
      note: 'Provider-reported costs come from Plivo callbacks/CDRs. Estimates use your configured per-minute rates. Neither is an invoice.',
    };
  }

  async callsCsv(ctx: RequestContext, range: Range): Promise<string> {
    this.check(range);
    const where = await this.callScope(ctx, range);
    const rows = await this.prisma.db.$queryRaw<Record<string, unknown>[]>`
      SELECT c.id, c."initiatedAt", u.name AS agent, l."fullName" AS lead, c.status::text AS status, c."isSimulated",
        c."countedAsAttempt", c."customerAnsweredAt", c."endedAt", c."talkSeconds", c."billableSeconds",
        c."costMicros", c."costCurrency", c."costSource"::text AS "costSource", c."failureReason", o."outcomeLabel"
      FROM calls c
      JOIN leads l ON l.id = c."leadId"
      JOIN memberships m ON m.id = c."membershipId"
      JOIN users u ON u.id = m."userId"
      LEFT JOIN call_outcomes o ON o."callId" = c.id
      WHERE ${where}
      ORDER BY c."initiatedAt" DESC
      LIMIT 100000`;
    const headers = ['Call ID', 'Started (UTC)', 'Agent', 'Lead', 'Status', 'Simulated', 'Attempt counted', 'Answered at', 'Ended at', 'Talk seconds', 'Billable seconds', 'Cost', 'Currency', 'Cost source', 'Failure reason', 'Outcome'];
    return toCsv(
      headers,
      rows.map((r) => [
        r.id,
        r.initiatedAt,
        r.agent,
        r.lead,
        r.status,
        r.isSimulated ? 'yes' : 'no',
        r.countedAsAttempt ? 'yes' : 'no',
        r.customerAnsweredAt,
        r.endedAt,
        r.talkSeconds,
        r.billableSeconds,
        r.costMicros != null ? (Number(r.costMicros) / 1_000_000).toFixed(4) : '',
        r.costCurrency,
        r.costSource,
        r.failureReason,
        r.outcomeLabel,
      ]),
    );
  }
}

@ApiTags('reports')
@Controller('reports')
@RequirePermissions('reports:read')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  @Get('overview')
  overview(@Ctx() ctx: RequestContext, @ZQuery(reportQuerySchema) q: Range) {
    return this.reports.overview(ctx, q);
  }

  @Get('calls-by-day')
  byDay(@Ctx() ctx: RequestContext, @ZQuery(reportQuerySchema) q: Range) {
    return this.reports.callsByDay(ctx, q, ctx.timezone);
  }

  @Get('agents')
  agents(@Ctx() ctx: RequestContext, @ZQuery(reportQuerySchema) q: Range) {
    return this.reports.agents(ctx, q);
  }

  @Get('callbacks')
  callbacks(@Ctx() ctx: RequestContext, @ZQuery(reportQuerySchema) q: Range) {
    return this.reports.callbackStats(ctx, q);
  }

  @Get('usage')
  usage(@Ctx() ctx: RequestContext, @ZQuery(reportQuerySchema) q: Range) {
    return this.reports.costs(ctx, q);
  }

  @Get('calls.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async callsCsv(@Ctx() ctx: RequestContext, @ZQuery(reportQuerySchema) q: Range, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', `attachment; filename="calls-${q.from.toISOString().slice(0, 10)}-${q.to.toISOString().slice(0, 10)}.csv"`);
    await this.audit.fromCtx(ctx, 'report.exported', 'report', 'calls', { from: q.from.toISOString(), to: q.to.toISOString() });
    return this.reports.callsCsv(ctx, q);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
