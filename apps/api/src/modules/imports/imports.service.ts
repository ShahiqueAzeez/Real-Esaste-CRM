import { Injectable } from '@nestjs/common';
import { toCsv, type ImportMapping } from '@crm/shared';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { JobsService } from '../../infra/jobs/jobs.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../../infra/storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService } from '../org/org-core.service';
import { suggestMapping } from './import-rows';

export const MAX_IMPORT_ROWS = 100_000;
const ALLOWED_MIME = new Set(['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv', 'application/octet-stream', 'text/x-csv']);

export interface UploadedCsv {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class ImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  async upload(ctx: RequestContext, file: UploadedCsv | undefined) {
    if (!file) throw Errors.badRequest('FILE_REQUIRED', 'Choose a CSV file to upload');
    if (!/\.csv$/i.test(file.originalname) || !ALLOWED_MIME.has(file.mimetype)) throw Errors.badRequest('INVALID_FILE', 'Only .csv files are accepted');
    if (file.size === 0) throw Errors.badRequest('EMPTY_FILE', 'The file is empty');
    if (file.buffer.subarray(0, 4).includes(0)) throw Errors.badRequest('INVALID_FILE', 'The file does not look like text CSV');
    await this.entitlements.assertOperational(ctx.tenantId);

    // Read only the start of the file for headers and a sample; the worker parses the rest.
    let head: string[][];
    try {
      head = parse(file.buffer.subarray(0, 256 * 1024), { bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true, to_line: 21 }) as string[][];
    } catch {
      throw Errors.badRequest('INVALID_CSV', 'The file could not be read as CSV');
    }
    const headers = (head[0] ?? []).map((h, i) => (h || `Column ${i + 1}`).slice(0, 200));
    if (headers.length < 2) throw Errors.badRequest('INVALID_CSV', 'The file needs a header row with at least two columns');
    if (new Set(headers).size !== headers.length) throw Errors.badRequest('DUPLICATE_HEADERS', 'Column names in the header row must be unique');

    const id = randomUUID();
    const storageKey = `imports/${ctx.tenantId}/${id}.csv`;
    await this.storage.put(storageKey, file.buffer, 'text/csv');
    const job = await this.prisma.db.leadImportJob.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        fileName: file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 200),
        storageKey,
        fileSize: file.size,
        status: 'UPLOADED',
        headers,
        sampleRows: head.slice(1, 6).map((r) => r.map((c) => String(c ?? '').slice(0, 200))),
        mapping: suggestMapping(headers),
        createdByMembershipId: ctx.membershipId,
      },
    });
    await this.audit.fromCtx(ctx, 'import.uploaded', 'import', job.id, { fileSize: file.size });
    return job;
  }

  list(ctx: RequestContext) {
    return this.prisma.db.leadImportJob.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, fileName: true, status: true, totalRows: true, validRows: true, invalidRows: true, importedRows: true, updatedRows: true, createdAt: true, completedAt: true },
    });
  }

  async get(ctx: RequestContext, id: string) {
    const job = await this.prisma.db.leadImportJob.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!job) throw Errors.notFound('Import');
    const allowance = await this.entitlements.importAllowance(ctx.tenantId);
    return { ...job, allowance };
  }

  async setMapping(ctx: RequestContext, id: string, body: ImportMapping) {
    const job = await this.prisma.db.leadImportJob.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!job) throw Errors.notFound('Import');
    if (!['UPLOADED', 'PREVIEW_READY', 'FAILED'].includes(job.status)) throw Errors.conflict('IMPORT_BUSY', 'This import is already being processed');
    const headers = (job.headers as string[]) ?? [];
    for (const [field, col] of Object.entries(body.mapping)) {
      if (col && !headers.includes(col)) throw Errors.badRequest('UNKNOWN_COLUMN', `Column "${col}" mapped to ${field} is not in the file`);
    }
    if (body.options.assignToMembershipId) {
      const agent = await this.prisma.db.membership.findFirst({ where: { id: body.options.assignToMembershipId, tenantId: ctx.tenantId, role: 'AGENT', status: 'ACTIVE' } });
      if (!agent) throw Errors.badRequest('INVALID_ASSIGNEE', 'Leads can only be assigned to active agents');
    }
    if (body.options.queueId) {
      const queue = await this.prisma.db.queue.findFirst({ where: { id: body.options.queueId, tenantId: ctx.tenantId } });
      if (!queue) throw Errors.badRequest('QUEUE_NOT_FOUND', 'Queue not found');
    }
    await this.prisma.db.leadImportJob.update({
      where: { id, tenantId: ctx.tenantId },
      data: { mapping: body.mapping, options: JSON.parse(JSON.stringify(body.options)), status: 'VALIDATING', processedRows: 0, failureReason: null },
    });
    await this.jobs.add('imports.validate', { tenantId: ctx.tenantId, importId: id }, { jobId: `validate-${id}-${Date.now()}`, attempts: 2 });
    return this.get(ctx, id);
  }

  async confirm(ctx: RequestContext, id: string) {
    const job = await this.prisma.db.leadImportJob.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!job) throw Errors.notFound('Import');
    if (job.status !== 'PREVIEW_READY') throw Errors.conflict('NOT_VALIDATED', 'Validate the file before importing');
    await this.entitlements.assertOperational(ctx.tenantId);
    // Existing numbers are skipped or updated, never added again, so they do not use allowance.
    const newLeads = Math.max(0, job.validRows - job.existingRows);
    const allowance = await this.entitlements.importAllowance(ctx.tenantId);
    if (newLeads > allowance.remaining) {
      throw Errors.conflict('IMPORT_LIMIT', `This import adds ${newLeads.toLocaleString()} leads but your plan allows ${allowance.remaining.toLocaleString()} more this month.`);
    }
    const updated = await this.prisma.db.leadImportJob.updateMany({ where: { id, tenantId: ctx.tenantId, status: 'PREVIEW_READY' }, data: { status: 'IMPORTING', processedRows: 0 } });
    if (updated.count === 0) throw Errors.conflict('IMPORT_BUSY', 'This import is already being processed');
    await this.jobs.add('imports.import', { tenantId: ctx.tenantId, importId: id }, { jobId: `import-${id}`, attempts: 3 });
    await this.audit.fromCtx(ctx, 'import.confirmed', 'import', id, { validRows: job.validRows });
    return this.get(ctx, id);
  }

  async cancel(ctx: RequestContext, id: string) {
    const res = await this.prisma.db.leadImportJob.updateMany({
      where: { id, tenantId: ctx.tenantId, status: { in: ['UPLOADED', 'PREVIEW_READY', 'FAILED', 'VALIDATING'] } },
      data: { status: 'CANCELLED' },
    });
    if (res.count === 0) throw Errors.conflict('CANNOT_CANCEL', 'This import can no longer be cancelled');
    return this.get(ctx, id);
  }

  async errorReport(ctx: RequestContext, id: string): Promise<string> {
    const job = await this.prisma.db.leadImportJob.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!job) throw Errors.notFound('Import');
    try {
      return (await this.storage.get(`${job.storageKey.replace(/\.csv$/, '')}-errors.csv`)).toString('utf8');
    } catch {
      const sample = ((job.errorSample ?? []) as { row: number; errors: string[] }[]).map((e) => [e.row, e.errors.join('; ')]);
      return toCsv(['Row', 'Problems'], sample);
    }
  }
}
