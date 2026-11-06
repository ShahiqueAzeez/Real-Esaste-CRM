import { Controller, Delete, Get, Header, HttpCode, Module, Patch, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  bulkAssignSchema,
  bulkQueueSchema,
  bulkStatusSchema,
  consentUpdateSchema,
  leadCreateSchema,
  leadListQuerySchema,
  leadNoteSchema,
  leadUpdateSchema,
  listQuerySchema,
} from '@crm/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { UuidParam, ZBody, ZQuery } from '../../common/pipes/zod';
import { LeadsService } from './leads.service';

@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @ZQuery(leadListQuerySchema) q: z.output<typeof leadListQuerySchema>) {
    return this.leads.list(ctx, q);
  }

  @Get('export')
  @RequirePermissions('leads:export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async export(@Ctx() ctx: RequestContext, @ZQuery(leadListQuerySchema.partial()) q: Partial<z.output<typeof leadListQuerySchema>>, @Res({ passthrough: true }) res: Response) {
    const { csv } = await this.leads.exportCsv(ctx, q);
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  @Post()
  @RequirePermissions('leads:write')
  create(@Ctx() ctx: RequestContext, @ZBody(leadCreateSchema) body: z.output<typeof leadCreateSchema>) {
    return this.leads.create(ctx, body).then((l) => this.leads.present(ctx, l));
  }

  @Post('bulk/assign')
  @RequirePermissions('leads:assign')
  bulkAssign(@Ctx() ctx: RequestContext, @ZBody(bulkAssignSchema) body: z.output<typeof bulkAssignSchema>) {
    return this.leads.bulkAssign(ctx, body);
  }

  @Post('bulk/status')
  @RequirePermissions('leads:write')
  bulkStatus(@Ctx() ctx: RequestContext, @ZBody(bulkStatusSchema) body: z.output<typeof bulkStatusSchema>) {
    return this.leads.bulkStatus(ctx, body);
  }

  @Post('bulk/queue')
  @RequirePermissions('leads:assign')
  bulkQueue(@Ctx() ctx: RequestContext, @ZBody(bulkQueueSchema) body: z.output<typeof bulkQueueSchema>) {
    return this.leads.bulkQueue(ctx, body);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.leads.get(ctx, id);
  }

  @Get(':id/activity')
  activity(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZQuery(listQuerySchema) q: z.output<typeof listQuerySchema>) {
    return this.leads.activity(ctx, id, q.page, q.pageSize);
  }

  @Patch(':id')
  @RequirePermissions('leads:write')
  update(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(leadUpdateSchema) body: z.output<typeof leadUpdateSchema>) {
    return this.leads.update(ctx, id, body);
  }

  @Delete(':id')
  @RequirePermissions('leads:delete')
  @HttpCode(204)
  remove(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.leads.remove(ctx, id);
  }

  @Post(':id/notes')
  addNote(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(leadNoteSchema) body: z.output<typeof leadNoteSchema>) {
    return this.leads.addNote(ctx, id, body.body);
  }

  @Post(':id/consent')
  @RequirePermissions('leads:write')
  consent(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(consentUpdateSchema) body: z.output<typeof consentUpdateSchema>) {
    return this.leads.updateConsent(ctx, id, body);
  }
}

@Module({ controllers: [LeadsController], providers: [LeadsService], exports: [LeadsService] })
export class LeadsModule {}
