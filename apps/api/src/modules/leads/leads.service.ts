import { Injectable } from '@nestjs/common';
import {
  FINAL_LEAD_STATUSES,
  PRIORITY_WEIGHT,
  toCsv,
  type bulkAssignSchema,
  type bulkQueueSchema,
  type bulkStatusSchema,
  type consentUpdateSchema,
  type LeadListQuery,
  type LeadPriority,
  type leadCreateSchema,
  type leadUpdateSchema,
} from '@crm/shared';
import { maskPhone, normalizePhone } from '@crm/shared/phone';
import type { Lead, Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { isUniqueViolation, PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ComplianceService } from '../compliance/compliance.service';
import { ScopeService, TenantSettingsService } from '../org/org-core.service';

const MAX_EXPORT_ROWS = 100_000;

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly settings: TenantSettingsService,
    private readonly compliance: ComplianceService,
    private readonly audit: AuditService,
  ) {}

  /** Agents never need a lead's full number (the server dials), so it is masked for them. */
  present(ctx: RequestContext, lead: Lead & Record<string, unknown>) {
    const masked = ctx.role === 'AGENT';
    return { ...lead, phoneE164: masked ? maskPhone(lead.phoneE164) : lead.phoneE164, phoneMasked: masked };
  }

  private async buildWhere(ctx: RequestContext, q: Partial<LeadListQuery>): Promise<Prisma.LeadWhereInput> {
    const base = await this.scope.leadWhere(ctx);
    const and: Prisma.LeadWhereInput[] = [base];
    if (q.q) {
      const digits = q.q.replace(/[^\d]/g, '');
      and.push({
        tenantId: ctx.tenantId,
        OR: [
          { fullName: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { preferredLocation: { contains: q.q, mode: 'insensitive' } },
          ...(digits.length >= 4 ? [{ phoneE164: { contains: digits } }] : []),
        ],
      });
    }
    if (q.status) and.push({ tenantId: ctx.tenantId, status: q.status });
    if (q.priority) and.push({ tenantId: ctx.tenantId, priority: q.priority });
    if (q.consentStatus) and.push({ tenantId: ctx.tenantId, consentStatus: q.consentStatus });
    if (q.source) and.push({ tenantId: ctx.tenantId, source: { equals: q.source, mode: 'insensitive' } });
    if (q.assignedMembershipId) and.push({ tenantId: ctx.tenantId, assignedMembershipId: q.assignedMembershipId === 'unassigned' ? null : q.assignedMembershipId });
    if (q.queueId) and.push({ tenantId: ctx.tenantId, queueItem: { is: { tenantId: ctx.tenantId, queueId: q.queueId } } });
    return { tenantId: ctx.tenantId, AND: and };
  }

  async list(ctx: RequestContext, q: LeadListQuery) {
    const where = await this.buildWhere(ctx, q);
    const orderBy: Prisma.LeadOrderByWithRelationInput = { [q.sort]: { sort: q.order, nulls: 'last' } } as Prisma.LeadOrderByWithRelationInput;
    const [rows, total] = await Promise.all([
      this.prisma.db.lead.findMany({
        where,
        orderBy: [orderBy, { id: 'asc' }],
        ...pageArgs(q.page, q.pageSize),
        include: { queueItem: { select: { state: true, availableAt: true, attempts: true, queueId: true, isCallback: true, doneReason: true } } },
      }),
      this.prisma.db.lead.count({ where }),
    ]);
    const names = await this.memberNames(ctx, rows.map((r) => r.assignedMembershipId));
    return toPage(
      rows.map((r) => ({ ...this.present(ctx, r), assignedTo: r.assignedMembershipId ? (names.get(r.assignedMembershipId) ?? null) : null })),
      total,
      q.page,
      q.pageSize,
    );
  }

  async memberNames(ctx: RequestContext, ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.db.membership.findMany({ where: { tenantId: ctx.tenantId, id: { in: unique } }, select: { id: true, user: { select: { name: true } } } });
    return new Map(rows.map((r) => [r.id, r.user.name]));
  }

  async findVisible(ctx: RequestContext, id: string): Promise<Lead> {
    const where = await this.scope.leadWhere(ctx);
    const lead = await this.prisma.db.lead.findFirst({ where: { AND: [where, { id, tenantId: ctx.tenantId }], tenantId: ctx.tenantId } });
    if (!lead) throw Errors.notFound('Lead');
    return lead;
  }

  async get(ctx: RequestContext, id: string) {
    const lead = await this.findVisible(ctx, id);
    const callWhere = await this.scope.callWhere(ctx);
    const [queueItem, notes, calls, callbacks, names] = await Promise.all([
      this.prisma.db.queueItem.findFirst({ where: { tenantId: ctx.tenantId, leadId: id }, include: { queue: { select: { id: true, name: true } } } }),
      this.prisma.db.leadNote.findMany({ where: { tenantId: ctx.tenantId, leadId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.db.call.findMany({
        where: { AND: [callWhere, { leadId: id, tenantId: ctx.tenantId }], tenantId: ctx.tenantId },
        orderBy: { initiatedAt: 'desc' },
        take: 25,
        include: { outcome: true, recordings: { where: { tenantId: ctx.tenantId, status: 'AVAILABLE' }, select: { id: true, durationSeconds: true } } },
      }),
      this.prisma.db.callback.findMany({ where: { tenantId: ctx.tenantId, leadId: id }, orderBy: { dueAt: 'desc' }, take: 20 }),
      this.memberNames(ctx, [lead.assignedMembershipId]),
    ]);
    const authorNames = await this.memberNames(ctx, [...notes.map((n) => n.authorMembershipId), ...calls.map((c) => c.membershipId)]);
    return {
      lead: { ...this.present(ctx, lead), assignedTo: lead.assignedMembershipId ? (names.get(lead.assignedMembershipId) ?? null) : null },
      queueItem,
      notes: notes.map((n) => ({ ...n, author: n.authorMembershipId ? (authorNames.get(n.authorMembershipId) ?? null) : null })),
      calls: calls.map((c) => ({
        id: c.id,
        status: c.status,
        isSimulated: c.isSimulated,
        initiatedAt: c.initiatedAt,
        talkSeconds: c.talkSeconds,
        agent: authorNames.get(c.membershipId) ?? null,
        outcome: c.outcome ? { code: c.outcome.outcomeCode, label: c.outcome.outcomeLabel, notes: c.outcome.notes } : null,
        recordings: c.recordings,
      })),
      callbacks,
    };
  }

  async activity(ctx: RequestContext, id: string, page: number, pageSize: number) {
    await this.findVisible(ctx, id);
    const where = { tenantId: ctx.tenantId, leadId: id };
    const [items, total] = await Promise.all([
      this.prisma.db.leadActivity.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(page, pageSize) }),
      this.prisma.db.leadActivity.count({ where }),
    ]);
    return toPage(items, total, page, pageSize);
  }

  private async assertAssignable(ctx: RequestContext, membershipId: string | null | undefined, tx?: Tx) {
    if (!membershipId) return;
    const m = await (tx ?? this.prisma.db).membership.findFirst({ where: { id: membershipId, tenantId: ctx.tenantId, status: 'ACTIVE', role: 'AGENT' } });
    if (!m) throw Errors.badRequest('INVALID_ASSIGNEE', 'Leads can only be assigned to active agents');
  }

  private async resolveQueue(tenantId: string, queueId: string | null | undefined, tx: Tx) {
    const queue = queueId
      ? await tx.queue.findFirst({ where: { id: queueId, tenantId } })
      : await tx.queue.findFirst({ where: { tenantId, isDefault: true } });
    if (!queue) throw Errors.badRequest('QUEUE_NOT_FOUND', 'Queue not found');
    return queue;
  }

  async create(ctx: RequestContext, body: z.output<typeof leadCreateSchema>) {
    const { settings } = await this.settings.get(ctx.tenantId);
    const parsed = normalizePhone(body.phone, settings.leads.defaultCountry, settings.calling.allowedCountries);
    if (!parsed.ok) {
      throw Errors.badRequest('INVALID_PHONE', parsed.error === 'COUNTRY_NOT_ALLOWED' ? 'Numbers from that country are not allowed for this organization' : 'Enter a valid phone number');
    }
    await this.assertAssignable(ctx, body.assignedMembershipId);
    try {
      return await this.prisma.db.$transaction(async (tx) => {
        const queue = await this.resolveQueue(ctx.tenantId, body.queueId, tx);
        const lead = await tx.lead.create({
          data: {
            tenantId: ctx.tenantId,
            fullName: body.fullName,
            phoneE164: parsed.value.e164,
            email: body.email,
            propertyInterest: body.propertyInterest,
            preferredLocation: body.preferredLocation,
            budgetMin: body.budgetMin == null ? null : BigInt(body.budgetMin),
            budgetMax: body.budgetMax == null ? null : BigInt(body.budgetMax),
            source: body.source,
            priority: body.priority,
            assignedMembershipId: body.assignedMembershipId ?? null,
            consentStatus: 'UNKNOWN',
          },
        });
        if (body.consentStatus !== 'UNKNOWN') {
          await this.compliance.recordConsent(tx, {
            tenantId: ctx.tenantId,
            leadId: lead.id,
            phoneE164: lead.phoneE164,
            status: body.consentStatus,
            source: body.consentSource ?? 'manual entry',
            evidence: body.consentEvidence,
            capturedAt: body.consentCapturedAt,
            membershipId: ctx.membershipId,
          });
        }
        const suppressed = await this.compliance.isSuppressed(tx, ctx.tenantId, lead.phoneE164, 'VOICE');
        await tx.queueItem.create({
          data: {
            tenantId: ctx.tenantId,
            queueId: queue.id,
            leadId: lead.id,
            priority: PRIORITY_WEIGHT[body.priority as LeadPriority],
            assignedMembershipId: settings.leads.strictOwnership ? (body.assignedMembershipId ?? null) : null,
            state: suppressed ? 'DONE' : 'WAITING',
            doneReason: suppressed ? 'SUPPRESSED' : null,
          },
        });
        await tx.leadActivity.create({ data: { tenantId: ctx.tenantId, leadId: lead.id, type: 'CREATED', actorMembershipId: ctx.membershipId, data: { queue: queue.name, suppressed } } });
        if (body.assignedMembershipId) {
          await tx.leadAssignment.create({ data: { tenantId: ctx.tenantId, leadId: lead.id, toMembershipId: body.assignedMembershipId, assignedByMembershipId: ctx.membershipId, reason: 'created' } });
        }
        if (body.note) await tx.leadNote.create({ data: { tenantId: ctx.tenantId, leadId: lead.id, authorMembershipId: ctx.membershipId, body: body.note } });
        return tx.lead.findFirstOrThrow({ where: { id: lead.id, tenantId: ctx.tenantId } });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await this.prisma.db.lead.findFirst({ where: { tenantId: ctx.tenantId, phoneE164: parsed.value.e164 }, select: { id: true } });
        throw Errors.conflict('DUPLICATE_LEAD', 'A lead with this phone number already exists', { leadId: existing?.id });
      }
      throw err;
    }
  }

  async update(ctx: RequestContext, id: string, body: z.output<typeof leadUpdateSchema>) {
    const lead = await this.findVisible(ctx, id);
    const data: Prisma.LeadUpdateInput = {
      fullName: body.fullName,
      email: body.email,
      propertyInterest: body.propertyInterest,
      preferredLocation: body.preferredLocation,
      budgetMin: body.budgetMin === undefined ? undefined : body.budgetMin === null ? null : BigInt(body.budgetMin),
      budgetMax: body.budgetMax === undefined ? undefined : body.budgetMax === null ? null : BigInt(body.budgetMax),
      source: body.source,
      priority: body.priority,
      status: body.status,
    };
    const updated = await this.prisma.db.$transaction(async (tx) => {
      const row = await tx.lead.update({ where: { id: lead.id, tenantId: ctx.tenantId }, data });
      if (body.priority) await tx.queueItem.updateMany({ where: { tenantId: ctx.tenantId, leadId: id }, data: { priority: PRIORITY_WEIGHT[body.priority] } });
      if (body.status && (FINAL_LEAD_STATUSES as string[]).includes(body.status)) {
        await tx.queueItem.updateMany({ where: { tenantId: ctx.tenantId, leadId: id, state: 'WAITING' }, data: { state: 'DONE', doneReason: `STATUS_${body.status}` } });
      }
      if (body.status && body.status !== lead.status) {
        await tx.leadActivity.create({ data: { tenantId: ctx.tenantId, leadId: id, type: 'STATUS_CHANGED', actorMembershipId: ctx.membershipId, data: { from: lead.status, to: body.status } } });
      }
      return row;
    });
    return this.present(ctx, updated);
  }

  async remove(ctx: RequestContext, id: string) {
    const lead = await this.findVisible(ctx, id);
    const active = await this.prisma.db.call.count({ where: { tenantId: ctx.tenantId, leadId: id, status: { in: ['INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED'] } } });
    if (active > 0) throw Errors.conflict('CALL_IN_PROGRESS', 'This lead is on a live call');
    await this.prisma.db.lead.delete({ where: { id: lead.id, tenantId: ctx.tenantId } });
    await this.audit.fromCtx(ctx, 'lead.deleted', 'lead', id);
  }

  async addNote(ctx: RequestContext, id: string, body: string) {
    await this.findVisible(ctx, id);
    const note = await this.prisma.db.leadNote.create({ data: { tenantId: ctx.tenantId, leadId: id, authorMembershipId: ctx.membershipId, body } });
    await this.prisma.db.leadActivity.create({ data: { tenantId: ctx.tenantId, leadId: id, type: 'NOTE_ADDED', actorMembershipId: ctx.membershipId } });
    return note;
  }

  async updateConsent(ctx: RequestContext, id: string, body: z.output<typeof consentUpdateSchema>) {
    const lead = await this.findVisible(ctx, id);
    await this.prisma.db.$transaction((tx) =>
      this.compliance.recordConsent(tx, { tenantId: ctx.tenantId, leadId: id, phoneE164: lead.phoneE164, status: body.status, source: body.source, evidence: body.evidence, capturedAt: body.capturedAt, membershipId: ctx.membershipId }),
    );
    await this.audit.fromCtx(ctx, 'lead.consent_updated', 'lead', id, { status: body.status });
    return this.findVisible(ctx, id).then((l) => this.present(ctx, l));
  }

  /** Visible lead ids among the requested ones (bulk operations never touch hidden leads). */
  private async visibleIds(ctx: RequestContext, ids: string[]): Promise<string[]> {
    const where = await this.scope.leadWhere(ctx);
    const rows = await this.prisma.db.lead.findMany({ where: { AND: [where, { id: { in: ids }, tenantId: ctx.tenantId }], tenantId: ctx.tenantId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async bulkAssign(ctx: RequestContext, body: z.output<typeof bulkAssignSchema>) {
    await this.assertAssignable(ctx, body.membershipId);
    const ids = await this.visibleIds(ctx, body.leadIds);
    const { settings } = await this.settings.get(ctx.tenantId);
    const queue = body.queueId ? await this.prisma.db.queue.findFirst({ where: { id: body.queueId, tenantId: ctx.tenantId } }) : null;
    if (body.queueId && !queue) throw Errors.badRequest('QUEUE_NOT_FOUND', 'Queue not found');
    const before = await this.prisma.db.lead.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, assignedMembershipId: true } });
    await this.prisma.db.$transaction(async (tx) => {
      await tx.lead.updateMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, data: { assignedMembershipId: body.membershipId } });
      await tx.queueItem.updateMany({
        where: { tenantId: ctx.tenantId, leadId: { in: ids }, state: { in: ['WAITING', 'DONE'] } },
        data: { ...(settings.leads.strictOwnership ? { assignedMembershipId: body.membershipId } : {}), ...(queue ? { queueId: queue.id } : {}) },
      });
      await tx.leadAssignment.createMany({
        data: before.map((l) => ({ tenantId: ctx.tenantId, leadId: l.id, fromMembershipId: l.assignedMembershipId, toMembershipId: body.membershipId, assignedByMembershipId: ctx.membershipId, reason: 'bulk_assign' })),
      });
      await tx.leadActivity.createMany({
        data: ids.map((leadId) => ({ tenantId: ctx.tenantId, leadId, type: 'ASSIGNED', actorMembershipId: ctx.membershipId, data: { to: body.membershipId, queueId: queue?.id ?? null } })),
      });
    });
    await this.audit.fromCtx(ctx, 'lead.bulk_assigned', 'lead', undefined, { count: ids.length, to: body.membershipId });
    return { updated: ids.length, skipped: body.leadIds.length - ids.length };
  }

  async bulkStatus(ctx: RequestContext, body: z.output<typeof bulkStatusSchema>) {
    const ids = await this.visibleIds(ctx, body.leadIds);
    const final = (FINAL_LEAD_STATUSES as string[]).includes(body.status);
    await this.prisma.db.$transaction(async (tx) => {
      await tx.lead.updateMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, data: { status: body.status } });
      if (final) await tx.queueItem.updateMany({ where: { tenantId: ctx.tenantId, leadId: { in: ids }, state: 'WAITING' }, data: { state: 'DONE', doneReason: `STATUS_${body.status}` } });
      await tx.leadActivity.createMany({ data: ids.map((leadId) => ({ tenantId: ctx.tenantId, leadId, type: 'STATUS_CHANGED', actorMembershipId: ctx.membershipId, data: { to: body.status, bulk: true } })) });
    });
    await this.audit.fromCtx(ctx, 'lead.bulk_status', 'lead', undefined, { count: ids.length, status: body.status });
    return { updated: ids.length, skipped: body.leadIds.length - ids.length };
  }

  /**
   * Put leads (back) into a queue. Leads that are closed, suppressed, without required consent or
   * out of attempts are skipped and reported, never silently re-dialled.
   */
  async bulkQueue(ctx: RequestContext, body: z.output<typeof bulkQueueSchema>) {
    const ids = await this.visibleIds(ctx, body.leadIds);
    const { settings, timezone } = await this.settings.get(ctx.tenantId);
    const queue = await this.prisma.db.queue.findFirst({ where: { id: body.queueId, tenantId: ctx.tenantId } });
    if (!queue) throw Errors.badRequest('QUEUE_NOT_FOUND', 'Queue not found');
    const leads = await this.prisma.db.lead.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, include: { queueItem: true } });
    const skipped: Record<string, number> = {};
    let queued = 0;
    for (const lead of leads) {
      if (lead.queueItem && lead.queueItem.state === 'IN_PROGRESS') {
        skipped.IN_PROGRESS = (skipped.IN_PROGRESS ?? 0) + 1;
        continue;
      }
      const reasons = await this.compliance.voiceEligibility(this.prisma.db, ctx.tenantId, lead, { settings, timezone, attempts: lead.queueItem?.attempts ?? 0, ignoreHours: true });
      if (reasons.length) {
        for (const r of reasons) skipped[r] = (skipped[r] ?? 0) + 1;
        continue;
      }
      await this.prisma.db.queueItem.upsert({
        where: { leadId: lead.id, tenantId: ctx.tenantId },
        create: { tenantId: ctx.tenantId, queueId: queue.id, leadId: lead.id, priority: body.priority ?? PRIORITY_WEIGHT[lead.priority], assignedMembershipId: settings.leads.strictOwnership ? lead.assignedMembershipId : null },
        update: { queueId: queue.id, state: 'WAITING', availableAt: new Date(), doneReason: null, ...(body.priority !== undefined ? { priority: body.priority } : {}) },
      });
      queued++;
    }
    await this.audit.fromCtx(ctx, 'lead.bulk_queued', 'queue', queue.id, { queued, skipped });
    return { queued, skipped };
  }

  async exportCsv(ctx: RequestContext, q: Partial<LeadListQuery>): Promise<{ csv: string; count: number }> {
    const where = await this.buildWhere(ctx, q);
    const total = await this.prisma.db.lead.count({ where });
    if (total > MAX_EXPORT_ROWS) throw Errors.badRequest('EXPORT_TOO_LARGE', `Narrow the filters: exports are limited to ${MAX_EXPORT_ROWS.toLocaleString()} rows`);
    const headers = ['Name', 'Phone', 'Email', 'Status', 'Priority', 'Property interest', 'Location', 'Budget min', 'Budget max', 'Source', 'Consent', 'Consent source', 'Attempts', 'Last call', 'Last outcome', 'Next callback', 'Created'];
    const rows: unknown[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.db.lead.findMany({ where, orderBy: { id: 'asc' }, take: 2000, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
      for (const l of batch) {
        rows.push([l.fullName, l.phoneE164, l.email, l.status, l.priority, l.propertyInterest, l.preferredLocation, l.budgetMin?.toString(), l.budgetMax?.toString(), l.source, l.consentStatus, l.consentSource, l.attemptCount, l.lastCallAt, l.lastCallOutcome, l.nextCallbackAt, l.createdAt]);
      }
      if (batch.length < 2000) break;
      cursor = batch[batch.length - 1]!.id;
    }
    await this.audit.fromCtx(ctx, 'lead.exported', 'lead', undefined, { count: rows.length, filters: JSON.parse(JSON.stringify(q)) });
    return { csv: toCsv(headers, rows), count: rows.length };
  }
}
