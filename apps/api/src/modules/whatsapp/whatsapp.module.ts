import { Controller, Get, Global, Headers, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put, Delete, Query, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { listQuerySchema, whatsappConfigSchema, whatsappSendSchema, whatsappTemplateSchema } from '@crm/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { Ctx, Public, RequirePermissions, SkipCsrf, type RequestContext } from '../../common/auth-context';
import { UuidParam, ZBody, ZQuery } from '../../common/pipes/zod';
import { WhatsAppService } from './whatsapp.service';

const messagesQuery = listQuerySchema.extend({ leadId: z.uuid().optional() });

@ApiTags('whatsapp')
@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly wa: WhatsAppService) {}

  @Get('status')
  status(@Ctx() ctx: RequestContext) {
    return this.wa.status(ctx.tenantId);
  }

  @Put('config')
  @RequirePermissions('org:integrations:manage')
  save(@Ctx() ctx: RequestContext, @ZBody(whatsappConfigSchema) body: z.output<typeof whatsappConfigSchema>) {
    return this.wa.saveConfig(ctx, body);
  }

  @Delete('config')
  @RequirePermissions('org:integrations:manage')
  @HttpCode(204)
  remove(@Ctx() ctx: RequestContext) {
    return this.wa.removeConfig(ctx);
  }

  @Get('templates')
  templates(@Ctx() ctx: RequestContext) {
    return this.wa.listTemplates(ctx);
  }

  @Post('templates')
  @RequirePermissions('org:integrations:manage')
  createTemplate(@Ctx() ctx: RequestContext, @ZBody(whatsappTemplateSchema) body: z.output<typeof whatsappTemplateSchema>) {
    return this.wa.saveTemplate(ctx, body);
  }

  @Patch('templates/:id')
  @RequirePermissions('org:integrations:manage')
  updateTemplate(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(whatsappTemplateSchema) body: z.output<typeof whatsappTemplateSchema>) {
    return this.wa.saveTemplate(ctx, body, id);
  }

  @Post('send')
  @RequirePermissions('whatsapp:send')
  send(@Ctx() ctx: RequestContext, @ZBody(whatsappSendSchema) body: z.output<typeof whatsappSendSchema>) {
    return this.wa.sendManual(ctx, body.leadId, body.templateId);
  }

  @Get('messages')
  messages(@Ctx() ctx: RequestContext, @ZQuery(messagesQuery) q: z.output<typeof messagesQuery>) {
    return this.wa.listMessages(ctx, q.leadId, q.page, q.pageSize);
  }
}

/** Meta webhook endpoints, one URL per tenant (each tenant brings its own WhatsApp app). */
@Public()
@SkipCsrf()
@Throttle({ default: { limit: 3000, ttl: 60_000 } })
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly wa: WhatsAppService) {}

  @Get(':tenantId')
  @ApiExcludeEndpoint()
  verify(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    return this.wa.verifySubscription(tenantId, mode, token, challenge);
  }

  @Post(':tenantId')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') signature?: string) {
    await this.wa.handleWebhook(tenantId, req.rawBody, signature, req.body);
    return { ok: true };
  }
}

@Global()
@Module({ providers: [WhatsAppService], exports: [WhatsAppService] })
export class WhatsAppCoreModule {}

@Module({ controllers: [WhatsAppController, WhatsAppWebhookController] })
export class WhatsAppModule {}
