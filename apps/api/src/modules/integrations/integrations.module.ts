import { Controller, Delete, Get, HttpCode, Module, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { plivoConfigSchema } from '@crm/shared';
import type { z } from 'zod';
import { AppConfig } from '../../config/config';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { ZBody } from '../../common/pipes/zod';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { MailService } from '../../infra/mail/mail.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PlivoProvider } from '../telephony/plivo.provider';
import { TelephonyRegistry, type PlivoTenantConfig } from '../telephony/registry.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

/** Integration settings and status. Secrets are write-only: they are never returned. */
@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: TelephonyRegistry,
    private readonly whatsapp: WhatsAppService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermissions('org:integrations:manage')
  async status(@Ctx() ctx: RequestContext) {
    const row = await this.prisma.db.providerConfig.findFirst({ where: { tenantId: ctx.tenantId, provider: 'PLIVO' } });
    const cfg = (row?.config ?? {}) as Partial<PlivoTenantConfig>;
    const { provider, source } = await this.registry.resolve(ctx.tenantId);
    return {
      telephony: {
        active: provider?.kind ?? null,
        source,
        simulated: provider?.capabilities.simulated ?? false,
        plivo: row
          ? {
              enabled: row.enabled,
              status: row.status,
              authIdMasked: this.crypto.mask(cfg.authId),
              callerIds: cfg.callerIds ?? [],
              defaultCallerId: cfg.defaultCallerId ?? null,
              costCurrency: cfg.costCurrency ?? 'USD',
              lastError: row.lastError,
              lastCheckedAt: row.lastCheckedAt,
            }
          : null,
        webhookBase: this.config.webhookUrl('/plivo'),
        browserSipUriTemplate: this.config.env.PLIVO_BROWSER_SIP_URI_TEMPLATE,
      },
      whatsapp: await this.whatsapp.status(ctx.tenantId),
      email: { configured: this.mail.configured },
      storage: { driver: this.config.env.STORAGE_DRIVER },
    };
  }

  @Put('plivo')
  @RequirePermissions('org:integrations:manage')
  async savePlivo(@Ctx() ctx: RequestContext, @ZBody(plivoConfigSchema) body: z.output<typeof plivoConfigSchema>) {
    if (!body.callerIds.includes(body.defaultCallerId)) throw Errors.validation([{ path: 'defaultCallerId', message: 'The default caller ID must be one of the listed numbers' }]);
    const existing = await this.prisma.db.providerConfig.findFirst({ where: { tenantId: ctx.tenantId, provider: 'PLIVO' } });
    const prevToken = existing?.secretsEncrypted ? this.crypto.decryptJson<{ authToken: string }>(existing.secretsEncrypted).authToken : undefined;
    const authToken = body.authToken ?? prevToken;
    if (!authToken) throw Errors.validation([{ path: 'authToken', message: 'Paste the Plivo Auth Token' }]);
    const data = {
      enabled: body.enabled,
      status: body.enabled ? ('CONFIGURED' as const) : ('DISABLED' as const),
      config: { authId: body.authId, callerIds: body.callerIds, defaultCallerId: body.defaultCallerId, costCurrency: (existing?.config as Partial<PlivoTenantConfig> | undefined)?.costCurrency ?? 'USD' },
      secretsEncrypted: this.crypto.encryptJson({ authToken }),
      updatedByMembershipId: ctx.membershipId,
      lastError: null,
    };
    await this.prisma.db.providerConfig.upsert({
      where: { tenantId_provider: { tenantId: ctx.tenantId, provider: 'PLIVO' } },
      create: { tenantId: ctx.tenantId, provider: 'PLIVO', ...data },
      update: data,
    });
    this.registry.invalidate(ctx.tenantId);
    await this.audit.fromCtx(ctx, 'integration.plivo_saved', 'provider_config', 'PLIVO', { enabled: body.enabled, callerIds: body.callerIds.length, tokenChanged: !!body.authToken });
    return this.status(ctx);
  }

  /** Verifies credentials by reading the Plivo account. Places no call and costs nothing. */
  @Post('plivo/test')
  @RequirePermissions('org:integrations:manage')
  @HttpCode(200)
  async testPlivo(@Ctx() ctx: RequestContext) {
    const row = await this.prisma.db.providerConfig.findFirst({ where: { tenantId: ctx.tenantId, provider: 'PLIVO' } });
    if (!row?.secretsEncrypted) throw Errors.precondition('NOT_CONFIGURED', 'Save Plivo credentials first');
    const cfg = row.config as unknown as PlivoTenantConfig;
    const provider = new PlivoProvider(
      { authId: cfg.authId, authToken: this.crypto.decryptJson<{ authToken: string }>(row.secretsEncrypted).authToken },
      { callerIds: cfg.callerIds, defaultCallerId: cfg.defaultCallerId, costCurrency: cfg.costCurrency ?? 'USD', sipUriTemplate: this.config.env.PLIVO_BROWSER_SIP_URI_TEMPLATE, timeoutMs: this.config.env.PLIVO_API_TIMEOUT_MS, webhookUrl: (p) => this.config.webhookUrl(p) },
    );
    const result = await provider.testConnection();
    await this.prisma.db.providerConfig.update({
      where: { id: row.id, tenantId: ctx.tenantId },
      data: { lastCheckedAt: new Date(), lastError: result.ok ? null : result.message, status: result.ok ? (row.enabled ? 'CONFIGURED' : 'DISABLED') : 'ERROR' },
    });
    this.registry.invalidate(ctx.tenantId);
    await this.audit.fromCtx(ctx, 'integration.plivo_tested', 'provider_config', 'PLIVO', { ok: result.ok });
    return result;
  }

  @Delete('plivo')
  @RequirePermissions('org:integrations:manage')
  @HttpCode(204)
  async removePlivo(@Ctx() ctx: RequestContext) {
    await this.prisma.db.providerConfig.deleteMany({ where: { tenantId: ctx.tenantId, provider: 'PLIVO' } });
    this.registry.invalidate(ctx.tenantId);
    await this.audit.fromCtx(ctx, 'integration.plivo_removed', 'provider_config', 'PLIVO');
  }
}

@Module({ controllers: [IntegrationsController] })
export class IntegrationsModule {}
