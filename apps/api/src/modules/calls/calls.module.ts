import { Controller, Get, Global, Module, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { queueSchema } from '@crm/shared';
import type { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { UuidParam, ZBody } from '../../common/pipes/zod';
import { AgentStateService } from '../agent/agent-state.service';
import { AgentController } from '../agent/agent.controller';
import { AgentService } from '../agent/agent.service';
import { ReservationService } from '../queues/reservation.service';
import { QueuesService } from '../queues/queues.service';
import { PlivoWebhooksController } from '../telephony/plivo-webhooks.controller';
import { TelephonyController } from '../telephony/telephony.controller';
import { CallLifecycleService } from './call-lifecycle.service';
import { CallsQueryService } from './calls-query.service';
import { CallsController } from './calls.controller';
import { DialerService } from './dialer.service';
import { WrapUpService } from './wrap-up.service';

const SERVICES = [AgentStateService, AgentService, ReservationService, QueuesService, CallLifecycleService, WrapUpService, DialerService, CallsQueryService];

/** Calling domain services shared by the API and worker processes. */
@Global()
@Module({ providers: SERVICES, exports: SERVICES })
export class CallsCoreModule {}

@ApiTags('queues')
@Controller('queues')
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get()
  list(@Ctx() ctx: RequestContext) {
    return this.queues.list(ctx);
  }

  @Post()
  @RequirePermissions('queues:manage')
  create(@Ctx() ctx: RequestContext, @ZBody(queueSchema) body: z.output<typeof queueSchema>) {
    return this.queues.save(ctx, body);
  }

  @Patch(':id')
  @RequirePermissions('queues:manage')
  update(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(queueSchema) body: z.output<typeof queueSchema>) {
    return this.queues.save(ctx, body, id);
  }
}

/** HTTP surface for calling (API process only). */
@Module({ controllers: [AgentController, CallsController, QueuesController, TelephonyController, PlivoWebhooksController] })
export class CallsModule {}
