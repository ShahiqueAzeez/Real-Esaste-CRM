import { Injectable, Logger } from '@nestjs/common';
import { PRIORITY_WEIGHT, RealtimeEvent, toCsv, type ImportMapping, type LeadImportField } from '@crm/shared';
import type { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RealtimeService } from '../../infra/realtime/realtime.service';
import { StorageService } from '../../infra/storage/storage.service';
import { TenantSettingsService } from '../org/org-core.service';
import { validateRow, type NormalizedImportRow } from './import-rows';
import { MAX_IMPORT_ROWS } from './imports.service';

const BATCH = 500;

interface Parsed {
  valid: NormalizedImportRow[];
  errors: { row: number; errors: string[] }[];
  duplicates: number;
  total: number;
}

/**
 * Worker-side CSV processing. Validation and import re-parse the stored file deterministically,
 * so a retried job produces the same result and never double-inserts (unique tenant+phone).
 */
@Injectable()
export class ImportRunner {
  private readonly logger = new Logger('Imports');
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly settings: TenantSettingsService,
    private readonly realtime: RealtimeService,
  ) {}

  private async progress(tenantId: string, importId: string, status: string, processed: number, total: number) {
    await this.prisma.system.leadImportJob.update({ where: { id: importId }, data: { processedRows: processed } });
    await this.realtime.toTenant(tenantId, RealtimeEvent.IMPORT_PROGRESS, { importId, status, processed, total });
  }

  private async parseFile(job: { id: string; tenantId: string; storageKey: string; mapping: Prisma.JsonValue; options: Prisma.JsonValue }): Promise<Parsed> {
    const { settings } = await this.settings.get(job.tenantId);
    const buffer = await this.storage.get(job.storageKey);
    const records = parse(buffer, { bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true, to_line: MAX_IMPORT_ROWS + 2 }) as string[][];
    const headers = records[0] ?? [];
    const data = records.slice(1);
    if (data.length > MAX_IMPORT_ROWS) throw new Error(`The file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it into smaller files.`);
    const options = (job.options ?? {}) as ImportMapping['options'];
    const ctx = {
      headerIndex: new Map(headers.map((h, i) => [h || `Column ${i + 1}`, i])),
      mapping: (job.mapping ?? {}) as Partial<Record<LeadImportField, string | null>>,
      defaultCountry: settings.leads.defaultCountry,
      allowedCountries: settings.calling.allowedCountries,
      defaultSource: options.defaultSource ?? null,
    };
    const seen = new Set<string>();
    const result: Parsed = { valid: [], errors: [], duplicates: 0, total: data.length };
    data.forEach((cells, i) => {
      const rowNumber = i + 2;
      const r = validateRow(cells, rowNumber, ctx);
      if (!r.ok) result.errors.push({ row: rowNumber, errors: r.errors });
      else if (seen.has(r.row.phoneE164)) {
        result.duplicates++;
        result.errors.push({ row: rowNumber, errors: ['Duplicate phone number of an earlier row (skipped)'] });
      } else {
        seen.add(r.row.phoneE164);
        result.valid.push(r.row);
        if (r.row.warnings.length) result.errors.push({ row: rowNumber, errors: r.row.warnings.map((w) => `Warning: ${w}`) });
      }
    });
    return result;
  }

  private async existingByPhone(tenantId: string, phones: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let i = 0; i < phones.length; i += 1000) {
      const rows = await this.prisma.system.lead.findMany({ where: { tenantId, phoneE164: { in: phones.slice(i, i + 1000) } }, select: { id: true, phoneE164: true } });
      for (const r of rows) map.set(r.phoneE164, r.id);
    }
    return map;
  }

  private async suppressedPhones(tenantId: string, phones: string[]): Promise<Set<string>> {
    const set = new Set<string>();
    const now = new Date();
    for (let i = 0; i < phones.length; i += 1000) {
      const rows = await this.prisma.system.suppressionEntry.findMany({
        where: { tenantId, phoneE164: { in: phones.slice(i, i + 1000) }, channel: { in: ['ALL', 'VOICE'] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { phoneE164: true },
      });
      for (const r of rows) set.add(r.phoneE164);
    }
    return set;
  }

  async validate(importId: string): Promise<void> {
    const job = await this.prisma.system.leadImportJob.findUnique({ where: { id: importId } });
    if (!job || job.status !== 'VALIDATING') return;
    try {
      const parsed = await this.parseFile(job);
      const phones = parsed.valid.map((r) => r.phoneE164);
      const [existing, suppressed] = await Promise.all([this.existingByPhone(job.tenantId, phones), this.suppressedPhones(job.tenantId, phones)]);
      const invalidRows = new Set(parsed.errors.filter((e) => !e.errors.every((m) => m.startsWith('Warning:') || m.startsWith('Duplicate'))).map((e) => e.row)).size;
      const errorCsv = toCsv(['Row', 'Problems'], parsed.errors.map((e) => [e.row, e.errors.join('; ')]));
      await this.storage.put(`${job.storageKey.replace(/\.csv$/, '')}-errors.csv`, Buffer.from(errorCsv, 'utf8'), 'text/csv');
      await this.prisma.system.leadImportJob.update({
        where: { id: importId },
        data: {
          status: 'PREVIEW_READY',
          totalRows: parsed.total,
          validRows: parsed.valid.length,
          invalidRows,
          duplicateRows: parsed.duplicates,
          existingRows: existing.size,
          suppressedRows: suppressed.size,
          processedRows: parsed.total,
          validatedAt: new Date(),
          errorSample: parsed.errors.slice(0, 500),
          previewRows: parsed.valid.slice(0, 20).map((r) => ({
            row: r.rowNumber,
            fullName: r.fullName,
            phoneE164: r.phoneE164,
            email: r.email,
            preferredLocation: r.preferredLocation,
            budgetMin: r.budgetMin,
            budgetMax: r.budgetMax,
            consentStatus: r.consentStatus,
            existing: existing.has(r.phoneE164),
            suppressed: suppressed.has(r.phoneE164),
          })),
        },
      });
      await this.realtime.toTenant(job.tenantId, RealtimeEvent.IMPORT_PROGRESS, { importId, status: 'PREVIEW_READY', processed: parsed.total, total: parsed.total });
    } catch (err) {
      await this.fail(importId, job.tenantId, err);
    }
  }

  async runImport(importId: string): Promise<void> {
    const job = await this.prisma.system.leadImportJob.findUnique({ where: { id: importId } });
    if (!job || job.status !== 'IMPORTING') return;
    try {
      await this.prisma.system.leadImportJob.update({ where: { id: importId }, data: { startedAt: job.startedAt ?? new Date() } });
      const { settings } = await this.settings.get(job.tenantId);
      const options = (job.options ?? {}) as ImportMapping['options'];
      const parsed = await this.parseFile(job);
      const queue = options.queueId
        ? await this.prisma.system.queue.findFirst({ where: { id: options.queueId, tenantId: job.tenantId } })
        : await this.prisma.system.queue.findFirst({ where: { tenantId: job.tenantId, isDefault: true } });
      if (!queue) throw new Error('Target queue no longer exists');
      const assignee = options.assignToMembershipId ?? null;
      const consentColumn = ((job.mapping ?? {}) as Record<string, string | null>).consentStatus ?? null;
      let imported = 0;
      let updated = 0;
      let skipped = 0;

      for (let i = 0; i < parsed.valid.length; i += BATCH) {
        const batch = parsed.valid.slice(i, i + BATCH);
        const existing = await this.existingByPhone(job.tenantId, batch.map((r) => r.phoneE164));
        const suppressed = await this.suppressedPhones(job.tenantId, batch.map((r) => r.phoneE164));
        const fresh = batch.filter((r) => !existing.has(r.phoneE164));
        const dupes = batch.filter((r) => existing.has(r.phoneE164));

        const consentFor = (r: NormalizedImportRow) => {
          if (r.consentStatus === 'GRANTED' || r.consentStatus === 'REVOKED') {
            return { status: r.consentStatus, source: r.consentSource ?? `CSV column "${consentColumn}" in ${job.fileName}`, evidence: null as string | null, capturedAt: r.consentCapturedAt };
          }
          if (options.consentAttestation) {
            return { status: 'GRANTED' as const, source: `Import attestation: ${options.consentAttestation.source}`, evidence: options.consentAttestation.evidence ?? null, capturedAt: options.consentAttestation.capturedAt ?? null };
          }
          return null;
        };

        await this.prisma.system.$transaction(async (tx) => {
          if (fresh.length) {
            const created = await tx.lead.createManyAndReturn({
              skipDuplicates: true,
              select: { id: true, phoneE164: true },
              data: fresh.map((r) => {
                const c = consentFor(r);
                return {
                  tenantId: job.tenantId,
                  fullName: r.fullName,
                  phoneE164: r.phoneE164,
                  email: r.email,
                  propertyInterest: r.propertyInterest,
                  preferredLocation: r.preferredLocation,
                  budgetMin: r.budgetMin === null ? null : BigInt(r.budgetMin),
                  budgetMax: r.budgetMax === null ? null : BigInt(r.budgetMax),
                  source: r.source,
                  priority: r.priority,
                  assignedMembershipId: assignee,
                  importJobId: job.id,
                  consentStatus: c?.status ?? 'UNKNOWN',
                  consentSource: c?.source ?? null,
                  consentEvidence: c?.evidence ?? null,
                  consentCapturedAt: c ? (c.capturedAt ?? new Date()) : null,
                };
              }),
            });
            const byPhone = new Map(fresh.map((r) => [r.phoneE164, r]));
            await tx.queueItem.createMany({
              skipDuplicates: true,
              data: created.map((l) => {
                const r = byPhone.get(l.phoneE164)!;
                const isSuppressed = suppressed.has(l.phoneE164);
                const revoked = consentFor(r)?.status === 'REVOKED';
                return {
                  tenantId: job.tenantId,
                  queueId: queue.id,
                  leadId: l.id,
                  priority: PRIORITY_WEIGHT[r.priority],
                  assignedMembershipId: settings.leads.strictOwnership ? assignee : null,
                  state: isSuppressed || revoked ? ('DONE' as const) : ('WAITING' as const),
                  doneReason: isSuppressed ? 'SUPPRESSED' : revoked ? 'CONSENT_REVOKED' : null,
                };
              }),
            });
            const consentRows = created.flatMap((l) => {
              const c = consentFor(byPhone.get(l.phoneE164)!);
              return c ? [{ tenantId: job.tenantId, leadId: l.id, phoneE164: l.phoneE164, status: c.status, source: c.source, evidence: c.evidence, capturedAt: c.capturedAt, recordedByMembershipId: job.createdByMembershipId }] : [];
            });
            if (consentRows.length) await tx.consentRecord.createMany({ data: consentRows });
            await tx.leadActivity.createMany({ data: created.map((l) => ({ tenantId: job.tenantId, leadId: l.id, type: 'IMPORTED', actorMembershipId: job.createdByMembershipId, data: { importId: job.id, file: job.fileName } })) });
            if (assignee) {
              await tx.leadAssignment.createMany({ data: created.map((l) => ({ tenantId: job.tenantId, leadId: l.id, toMembershipId: assignee, assignedByMembershipId: job.createdByMembershipId, reason: 'import' })) });
            }
            const noted = created.filter((l) => byPhone.get(l.phoneE164)?.notes);
            if (noted.length) {
              await tx.leadNote.createMany({ data: noted.map((l) => ({ tenantId: job.tenantId, leadId: l.id, authorMembershipId: job.createdByMembershipId, body: byPhone.get(l.phoneE164)!.notes! })) });
            }
            imported += created.length;
            skipped += fresh.length - created.length;
          }

          if (options.duplicateStrategy === 'UPDATE') {
            for (const r of dupes) {
              const leadId = existing.get(r.phoneE164)!;
              await tx.lead.update({
                where: { id: leadId },
                data: {
                  fullName: r.fullName,
                  email: r.email ?? undefined,
                  propertyInterest: r.propertyInterest ?? undefined,
                  preferredLocation: r.preferredLocation ?? undefined,
                  budgetMin: r.budgetMin === null ? undefined : BigInt(r.budgetMin),
                  budgetMax: r.budgetMax === null ? undefined : BigInt(r.budgetMax),
                  source: r.source ?? undefined,
                },
              });
              const c = consentFor(r);
              if (c) {
                await tx.consentRecord.create({ data: { tenantId: job.tenantId, leadId, phoneE164: r.phoneE164, status: c.status, source: c.source, evidence: c.evidence, capturedAt: c.capturedAt, recordedByMembershipId: job.createdByMembershipId } });
                await tx.lead.update({ where: { id: leadId }, data: { consentStatus: c.status, consentSource: c.source, consentEvidence: c.evidence, consentCapturedAt: c.capturedAt ?? new Date() } });
                if (c.status === 'REVOKED') await tx.queueItem.updateMany({ where: { tenantId: job.tenantId, leadId, state: 'WAITING' }, data: { state: 'DONE', doneReason: 'CONSENT_REVOKED' } });
              }
              await tx.leadActivity.create({ data: { tenantId: job.tenantId, leadId, type: 'IMPORT_UPDATED', actorMembershipId: job.createdByMembershipId, data: { importId: job.id } } });
              updated++;
            }
          } else {
            skipped += dupes.length;
          }
        });
        await this.progress(job.tenantId, importId, 'IMPORTING', Math.min(i + BATCH, parsed.valid.length), parsed.valid.length);
      }

      await this.prisma.system.usageLedgerEntry.upsert({
        where: { kind_sourceType_sourceId: { kind: 'LEAD_IMPORT', sourceType: 'import', sourceId: job.id } },
        create: { tenantId: job.tenantId, kind: 'LEAD_IMPORT', quantity: BigInt(imported), sourceType: 'import', sourceId: job.id, occurredAt: new Date() },
        update: { quantity: BigInt(imported) },
      });
      await this.prisma.system.leadImportJob.update({
        where: { id: importId },
        data: { status: 'COMPLETED', importedRows: imported, updatedRows: updated, skippedRows: skipped, completedAt: new Date(), processedRows: parsed.valid.length },
      });
      await this.prisma.system.notification.create({
        data: {
          tenantId: job.tenantId,
          membershipId: job.createdByMembershipId,
          type: 'IMPORT_COMPLETED',
          title: `Import finished: ${job.fileName}`,
          body: `${imported} added, ${updated} updated, ${skipped} skipped.`,
          data: { importId },
        },
      });
      await this.realtime.toTenant(job.tenantId, RealtimeEvent.IMPORT_PROGRESS, { importId, status: 'COMPLETED', processed: parsed.valid.length, total: parsed.valid.length });
      await this.realtime.toTenant(job.tenantId, RealtimeEvent.QUEUE_CHANGED, { queueId: queue.id });
    } catch (err) {
      await this.fail(importId, job.tenantId, err);
      throw err;
    }
  }

  private async fail(importId: string, tenantId: string, err: unknown) {
    const message = (err as Error)?.message?.slice(0, 500) ?? 'Unknown error';
    this.logger.error(`Import ${importId} failed: ${message}`);
    await this.prisma.system.leadImportJob.update({ where: { id: importId }, data: { status: 'FAILED', failureReason: message } }).catch(() => undefined);
    await this.realtime.toTenant(tenantId, RealtimeEvent.IMPORT_PROGRESS, { importId, status: 'FAILED', processed: 0, total: 0 });
  }
}
