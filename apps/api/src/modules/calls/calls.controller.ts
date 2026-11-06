import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { callListQuerySchema, outcomeSubmitSchema, recoverCallSchema } from '@crm/shared';
import { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { UuidParam, ZBody, ZQuery } from '../../common/pipes/zod';
import { CallsQueryService } from './calls-query.service';
import { DialerService } from './dialer.service';
import { WrapUpService } from './wrap-up.service';

const simulateSchema = z.object({ action: z.enum(['answer', 'busy', 'no-answer', 'fail', 'customer-hangup']) });

@ApiTags('calls')
@Controller('calls')
export class CallsController {
  constructor(
    private readonly dialer: DialerService,
    private readonly wrapUp: WrapUpService,
    private readonly query: CallsQueryService,
  ) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @ZQuery(callListQuerySchema) q: z.output<typeof callListQuerySchema>) {
    return this.query.list(ctx, q);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.query.detail(ctx, id);
  }

  @Get(':id/events')
  events(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    if (ctx.role === 'AGENT') throw Errors.forbidden();
    return this.query.events(ctx, id);
  }

  @Post(':id/hangup')
  @RequirePermissions('calls:dial')
  @HttpCode(200)
  hangup(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.dialer.agentHangup(ctx, id);
  }

  @Post(':id/outcome')
  @RequirePermissions('calls:dial')
  @HttpCode(200)
  outcome(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(outcomeSubmitSchema) body: z.output<typeof outcomeSubmitSchema>) {
    return this.wrapUp.submit(ctx, id, body);
  }

  @Post(':id/recover')
  @RequirePermissions('calls:recover')
  @HttpCode(200)
  recover(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(recoverCallSchema) body: z.output<typeof recoverCallSchema>) {
    return this.wrapUp.recover(ctx, id, body.notes);
  }

  @Post(':id/simulate')
  @RequirePermissions('calls:dial')
  @HttpCode(202)
  simulate(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(simulateSchema) body: z.output<typeof simulateSchema>) {
    return this.dialer.simulate(ctx, id, body.action);
  }
}
