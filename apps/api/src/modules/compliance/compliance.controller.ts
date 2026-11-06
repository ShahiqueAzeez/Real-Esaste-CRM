import { Controller, Delete, Get, HttpCode, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SUPPRESSION_CHANNELS, SUPPRESSION_REASONS, suppressionCreateSchema, suppressionListQuerySchema } from '@crm/shared';
import { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { UuidParam, ZBody, ZQuery } from '../../common/pipes/zod';
import { ComplianceService } from './compliance.service';

const bulkSchema = z.object({
  phones: z.array(z.string().max(40)).min(1).max(10000),
  reason: z.enum(SUPPRESSION_REASONS).default('DO_NOT_CALL'),
  channel: z.enum(SUPPRESSION_CHANNELS).default('ALL'),
});

@ApiTags('compliance')
@Controller('compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('summary')
  @RequirePermissions('compliance:read')
  summary(@Ctx() ctx: RequestContext) {
    return this.compliance.summary(ctx);
  }

  @Get('suppressions')
  @RequirePermissions('compliance:read')
  list(@Ctx() ctx: RequestContext, @ZQuery(suppressionListQuerySchema) q: z.output<typeof suppressionListQuerySchema>) {
    return this.compliance.listSuppressions(ctx, q.q, q.page, q.pageSize);
  }

  @Post('suppressions')
  @RequirePermissions('compliance:manage')
  add(@Ctx() ctx: RequestContext, @ZBody(suppressionCreateSchema) body: z.output<typeof suppressionCreateSchema>) {
    return this.compliance.addSuppression(ctx, body);
  }

  @Post('suppressions/bulk')
  @RequirePermissions('compliance:manage')
  bulk(@Ctx() ctx: RequestContext, @ZBody(bulkSchema) body: z.output<typeof bulkSchema>) {
    return this.compliance.bulkSuppress(ctx, body.phones, body.reason, body.channel);
  }

  @Delete('suppressions/:id')
  @RequirePermissions('compliance:manage')
  @HttpCode(204)
  remove(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.compliance.removeSuppression(ctx, id);
  }
}

@Module({ controllers: [ComplianceController] })
export class ComplianceModule {}
