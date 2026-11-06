import { Controller, Get, Module, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  mergeTenantSettings,
  outcomeDefinitionSchema,
  SYSTEM_OUTCOME_CODES,
  tenantSettingsPatchSchema,
  updateOrgSchema,
} from '@crm/shared';
import { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { UuidParam, ZBody } from '../../common/pipes/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementsService, TenantSettingsService } from './org-core.service';

const outcomeUpdateSchema = outcomeDefinitionSchema.partial().omit({ code: true });

@ApiTags('organization')
@Controller('org')
export class OrgController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: TenantSettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get(@Ctx() ctx: RequestContext) {
    const tenant = await this.prisma.system.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
    const { settings } = await this.settings.get(ctx.tenantId);
    const sub = await this.entitlements.subscription(ctx.tenantId);
    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, timezone: tenant.timezone, status: tenant.status },
      settings,
      subscription: {
        status: sub.status,
        plan: { code: sub.plan.code, name: sub.plan.name, maxAgents: sub.plan.maxAgents, maxConcurrentCalls: sub.plan.maxConcurrentCalls },
        features: this.entitlements.features(sub.plan),
        currentPeriodEnd: sub.currentPeriodEnd,
        trialEndsAt: sub.trialEndsAt,
        operational: this.entitlements.isOperational(sub.status),
      },
    };
  }

  @Patch()
  @RequirePermissions('org:settings:manage')
  async update(@Ctx() ctx: RequestContext, @ZBody(updateOrgSchema) body: z.output<typeof updateOrgSchema>) {
    const tenant = await this.prisma.system.tenant.update({ where: { id: ctx.tenantId }, data: body });
    await this.audit.fromCtx(ctx, 'org.updated', 'tenant', ctx.tenantId, body);
    return { id: tenant.id, name: tenant.name, timezone: tenant.timezone };
  }

  @Get('settings')
  async getSettings(@Ctx() ctx: RequestContext) {
    return (await this.settings.get(ctx.tenantId)).settings;
  }

  @Patch('settings')
  @RequirePermissions('org:settings:manage')
  async patchSettings(@Ctx() ctx: RequestContext, @ZBody(tenantSettingsPatchSchema) body: z.output<typeof tenantSettingsPatchSchema>) {
    const { settings } = await this.settings.get(ctx.tenantId);
    let merged;
    try {
      merged = mergeTenantSettings(settings, body);
    } catch (err) {
      if (err instanceof z.ZodError) throw Errors.validation(err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      throw err;
    }
    if (merged.recording.enabled && !settings.recording.enabled) {
      await this.entitlements.assertFeature(ctx.tenantId, 'recording', 'Call recording');
    }
    await this.prisma.system.tenant.update({ where: { id: ctx.tenantId }, data: { settings: merged as object } });
    await this.audit.fromCtx(ctx, 'org.settings_updated', 'tenant', ctx.tenantId, { sections: Object.keys(body) });
    return merged;
  }

  @Get('outcomes')
  outcomes(@Ctx() ctx: RequestContext) {
    return this.prisma.db.outcomeDefinition.findMany({ where: { tenantId: ctx.tenantId }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
  }

  @Post('outcomes')
  @RequirePermissions('org:settings:manage')
  async createOutcome(@Ctx() ctx: RequestContext, @ZBody(outcomeDefinitionSchema) body: z.output<typeof outcomeDefinitionSchema>) {
    if (body.retryBehavior === 'CALLBACK' && !body.requiresCallback) throw Errors.badRequest('INVALID_OUTCOME', 'Callback outcomes must require a callback time');
    const row = await this.prisma.db.outcomeDefinition.create({ data: { ...body, tenantId: ctx.tenantId, isSystem: false, selectable: true } });
    await this.audit.fromCtx(ctx, 'outcome.created', 'outcome', row.id, { code: row.code });
    return row;
  }

  @Patch('outcomes/:id')
  @RequirePermissions('org:settings:manage')
  async updateOutcome(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(outcomeUpdateSchema) body: z.output<typeof outcomeUpdateSchema>) {
    const existing = await this.prisma.db.outcomeDefinition.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!existing) throw Errors.notFound('Outcome');
    let data: typeof body = body;
    if (existing.isSystem || SYSTEM_OUTCOME_CODES.includes(existing.code)) {
      // System outcomes drive retries and suppression; only presentation fields are editable.
      data = { label: body.label, requiresNotes: body.requiresNotes, sortOrder: body.sortOrder };
    }
    const row = await this.prisma.db.outcomeDefinition.update({ where: { id: existing.id, tenantId: ctx.tenantId }, data });
    await this.audit.fromCtx(ctx, 'outcome.updated', 'outcome', row.id, { code: row.code });
    return row;
  }
}

@Module({ controllers: [OrgController] })
export class OrgModule {}
