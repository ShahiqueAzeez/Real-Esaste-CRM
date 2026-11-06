import { Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { agentStatusSchema, deviceReportSchema } from '@crm/shared';
import type { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { ZBody } from '../../common/pipes/zod';
import { DialerService } from '../calls/dialer.service';
import { AgentService } from './agent.service';

@ApiTags('agent')
@Controller('agent')
@RequirePermissions('calls:dial')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly dialer: DialerService,
  ) {}

  @Get('state')
  async state(@Ctx() ctx: RequestContext) {
    const [state, current] = await Promise.all([this.agent.state(ctx), this.dialer.current(ctx)]);
    return { ...state, currentCall: current };
  }

  @Post('status')
  @HttpCode(200)
  status(@Ctx() ctx: RequestContext, @ZBody(agentStatusSchema) body: z.output<typeof agentStatusSchema>) {
    return this.agent.setStatus(ctx, body);
  }

  @Post('device')
  @HttpCode(200)
  device(@Ctx() ctx: RequestContext, @ZBody(deviceReportSchema) body: z.output<typeof deviceReportSchema>) {
    return this.agent.reportDevice(ctx, body);
  }

  @Post('heartbeat')
  @HttpCode(204)
  async heartbeat(@Ctx() ctx: RequestContext) {
    await this.agent.heartbeat(ctx.tenantId, ctx.membershipId);
  }

  /** Reserve the next eligible lead and start the call. Send a fresh Idempotency-Key per click. */
  @Post('dial-next')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  dialNext(@Ctx() ctx: RequestContext, @Headers('idempotency-key') key?: string) {
    return this.dialer.dialNext(ctx, key);
  }

  @Get('today')
  today(@Ctx() ctx: RequestContext) {
    return this.agent.today(ctx);
  }
}
