import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { hasPermission } from '@crm/shared';
import { AppConfig } from '../../config/config';
import { Ctx, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TelephonyRegistry } from './registry.service';

const TOKEN_TTL_SECONDS = 3600;

@ApiTags('telephony')
@Controller('telephony')
export class TelephonyController {
  constructor(
    private readonly registry: TelephonyRegistry,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  @Get('status')
  async status(@Ctx() ctx: RequestContext) {
    const { provider, source } = await this.registry.resolve(ctx.tenantId);
    return {
      configured: !!provider,
      provider: provider?.kind ?? null,
      source,
      simulated: provider?.capabilities.simulated ?? false,
      capabilities: provider?.capabilities ?? null,
      mockControls: (provider?.capabilities.simulated ?? false) && this.config.env.ALLOW_MOCK_CONTROLS,
      callerIds: hasPermission(ctx.permissions, 'org:integrations:manage') ? (provider?.callerIds() ?? []) : undefined,
    };
  }

  /**
   * Receive-only Plivo JWT for this member's browser (agents and coaching supervisors).
   * Outgoing calls from the browser are not allowed: the server places every call.
   */
  @Post('browser-token')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async browserToken(@Ctx() ctx: RequestContext) {
    if (!hasPermission(ctx.permissions, 'calls:dial') && !hasPermission(ctx.permissions, 'monitor:coach')) throw Errors.forbidden();
    const provider = await this.registry.forTenant(ctx.tenantId);
    if (provider.capabilities.simulated) return { simulated: true, token: null, identity: null, expiresAt: null };
    const membership = await this.prisma.db.membership.findFirstOrThrow({ where: { id: ctx.membershipId, tenantId: ctx.tenantId } });
    const { token, expiresAt } = await provider.createBrowserToken(membership.telephonyIdentity, TOKEN_TTL_SECONDS);
    await this.audit.fromCtx(ctx, 'telephony.browser_token_issued', 'membership', ctx.membershipId);
    return { simulated: false, token, identity: membership.telephonyIdentity, expiresAt };
  }
}
