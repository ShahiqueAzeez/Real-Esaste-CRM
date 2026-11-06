import { Controller, Get, Header, Module, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { importMappingSchema } from '@crm/shared';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { UuidParam, ZBody } from '../../common/pipes/zod';
import { ImportsService, type UploadedCsv } from './imports.service';

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024;

@ApiTags('imports')
@Controller('imports')
@RequirePermissions('leads:import')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }))
  upload(@Ctx() ctx: RequestContext, @UploadedFile() file: UploadedCsv | undefined) {
    return this.imports.upload(ctx, file);
  }

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.imports.list(ctx);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.imports.get(ctx, id);
  }

  @Put(':id/mapping')
  map(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(importMappingSchema) body: z.output<typeof importMappingSchema>) {
    return this.imports.setMapping(ctx, id, body);
  }

  @Post(':id/confirm')
  confirm(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.imports.confirm(ctx, id);
  }

  @Post(':id/cancel')
  cancel(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.imports.cancel(ctx, id);
  }

  @Get(':id/errors.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async errors(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Disposition', `attachment; filename="import-${id.slice(0, 8)}-problems.csv"`);
    return this.imports.errorReport(ctx, id);
  }
}

@Module({ controllers: [ImportsController], providers: [ImportsService], exports: [ImportsService] })
export class ImportsModule {}
