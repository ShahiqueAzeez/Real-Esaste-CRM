import { Injectable, Logger } from '@nestjs/common';
import type { WaPurpose, whatsappConfigSchema, whatsappTemplateSchema } from '@crm/shared';
import type { WhatsAppMessage } from '@prisma/client';
import type { z } from 'zod';
import { AppConfig } from '../../config/config';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { JobsService } from '../../infra/jobs/jobs.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ComplianceService } from '../compliance/compliance.service';
import { EntitlementsService, ScopeService, TenantSettingsService } from '../org/org-core.service';
import { CloudApiClient, isOptOut, MockWhatsAppClient, verifyMetaSignature, WhatsAppError, type WhatsAppClient } from './whatsapp.client';

interface WaConfig {
  phoneNumberId: string;
  businessAccountId?: string | null;
  graphApiVersion: string;
}
interface WaSecrets {
  accessToken?: string;
  appSecret?: string;
  webhookVerifyToken?: string;
}

type PolicyResult = { ok: true } | { ok: false; reason: string };

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger('WhatsApp');
  private readonly mockClient = new MockWhatsAppClient();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
    private readonly jobs: JobsService,
    private readonly settings: TenantSettingsService,
    private readonly entitlements: EntitlementsService,
    private readonly compliance: ComplianceService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  private async loadConfig(tenantId: string) {
    const row = await this.prisma.system.providerConfig.findUnique({ where: { tenantId_provider: { tenantId, provider: 'WHATSAPP' } } });
    if (!row || !row.enabled || row.status === 'DISABLED') return null;
    const secrets = row.secretsEncrypted ? this.crypto.decryptJson<WaSecrets>(row.secretsEncrypted) : {};
    return { row, cfg: row.config as unknown as WaConfig, secrets };
  }

  /** Real Cloud API client when configured; the simulator only when explicitly allowed. */
  async client(tenantId: string): Promise<WhatsAppClient | null> {
    const loaded = await this.loadConfig(tenantId);
    if (loaded?.secrets.accessToken && loaded.cfg.phoneNumberId) {
      return new CloudApiClient({ baseUrl: this.config.env.WHATSAPP_GRAPH_BASE_URL, version: loaded.cfg.graphApiVersion, phoneNumberId: loaded.cfg.phoneNumberId, accessToken: loaded.secrets.accessToken });
    }
    return this.config.env.WHATSAPP_ALLOW_MOCK ? this.mockClient : null;
  }

  async status(tenantId: string) {
    const loaded = await this.loadConfig(tenantId);
    const configured = !!(loaded?.secrets.accessToken && loaded.cfg.phoneNumberId);
    return {
      configured,
      simulated: !configured && this.config.env.WHATSAPP_ALLOW_MOCK,
      webhookUrl: this.config.webhookUrl(`/whatsapp/${tenantId}`),
      phoneNumberId: loaded?.cfg.phoneNumberId ?? null,
      graphApiVersion: loaded?.cfg.graphApiVersion ?? null,
      hasAppSecret: !!loaded?.secrets.appSecret,
      hasVerifyToken: !!loaded?.secrets.webhookVerifyToken,
      lastError: loaded?.row.lastError ?? null,
    };
  }

  async saveConfig(ctx: RequestContext, body: z.output<typeof whatsappConfigSchema>) {
    const existing = await this.prisma.db.providerConfig.findFirst({ where: { tenantId: ctx.tenantId, provider: 'WHATSAPP' } });
    const prev = existing?.secretsEncrypted ? this.crypto.decryptJson<WaSecrets>(existing.secretsEncrypted) : {};
    const secrets: WaSecrets = {
      accessToken: body.accessToken ?? prev.accessToken,
      appSecret: body.appSecret ?? prev.appSecret,
      webhookVerifyToken: body.webhookVerifyToken ?? prev.webhookVerifyToken,
    };
    if (!secrets.accessToken) throw Errors.badRequest('ACCESS_TOKEN_REQUIRED', 'Paste a WhatsApp Cloud API access token');
    const data = {
      enabled: body.enabled,
      status: body.enabled ? ('CONFIGURED' as const) : ('DISABLED' as const),
      config: { phoneNumberId: body.phoneNumberId, businessAccountId: body.businessAccountId ?? null, graphApiVersion: body.graphApiVersion },
      secretsEncrypted: this.crypto.encryptJson(secrets),
      updatedByMembershipId: ctx.membershipId,
      lastError: null,
    };
    await this.prisma.db.providerConfig.upsert({
      where: { tenantId_provider: { tenantId: ctx.tenantId, provider: 'WHATSAPP' } },
      create: { tenantId: ctx.tenantId, provider: 'WHATSAPP', ...data },
      update: data,
    });
    await this.audit.fromCtx(ctx, 'integration.whatsapp_saved', 'provider_config', 'WHATSAPP', { enabled: body.enabled });
    return this.status(ctx.tenantId);
  }

  async removeConfig(ctx: RequestContext) {
    await this.prisma.db.providerConfig.deleteMany({ where: { tenantId: ctx.tenantId, provider: 'WHATSAPP' } });
    await this.audit.fromCtx(ctx, 'integration.whatsapp_removed', 'provider_config', 'WHATSAPP');
  }

  // ───── templates ─────
  listTemplates(ctx: RequestContext) {
    return this.prisma.db.whatsAppTemplate.findMany({ where: { tenantId: ctx.tenantId }, orderBy: [{ purpose: 'asc' }, { name: 'asc' }] });
  }

  async saveTemplate(ctx: RequestContext, body: z.output<typeof whatsappTemplateSchema>, id?: string) {
    if ((body.purpose === 'MISSED_CALL_FOLLOWUP' || body.purpose === 'CALLBACK_CONFIRMATION') && body.category !== 'UTILITY') {
      throw Errors.badRequest('UTILITY_ONLY', 'Automated follow-ups must use an approved UTILITY template, not a marketing template');
    }
    const row = id
      ? await this.prisma.db.whatsAppTemplate.update({ where: { id, tenantId: ctx.tenantId }, data: body })
      : await this.prisma.db.whatsAppTemplate.create({ data: { ...body, tenantId: ctx.tenantId } });
    await this.audit.fromCtx(ctx, id ? 'whatsapp.template_updated' : 'whatsapp.template_created', 'whatsapp_template', row.id);
    return row;
  }

  // ───── policy & sending ─────
  private async policy(tenantId: string, lead: { phoneE164: string; consentStatus: string }, template: { active: boolean; category: string }, automated: boolean): Promise<PolicyResult> {
    const sub = await this.entitlements.subscription(tenantId);
    if (!this.entitlements.isOperational(sub.status)) return { ok: false, reason: 'subscription_inactive' };
    if (!this.entitlements.features(sub.plan).whatsapp) return { ok: false, reason: 'plan_excludes_whatsapp' };
    if (!template.active) return { ok: false, reason: 'template_inactive' };
    if (automated && template.category !== 'UTILITY') return { ok: false, reason: 'automated_marketing_blocked' };
    const { settings } = await this.settings.get(tenantId);
    if (await this.compliance.isSuppressed(this.prisma.system, tenantId, lead.phoneE164, 'WHATSAPP')) return { ok: false, reason: 'opted_out' };
    if (lead.consentStatus === 'REVOKED') return { ok: false, reason: 'consent_revoked' };
    if (settings.consent.requireConsentForWhatsApp && lead.consentStatus !== 'GRANTED') return { ok: false, reason: 'no_consent' };
    const recent = await this.prisma.system.whatsAppMessage.count({
      where: { tenantId, phoneE164: lead.phoneE164, direction: 'OUTBOUND', status: { in: ['QUEUED', 'SENT', 'DELIVERED', 'READ'] }, createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
    });
    if (recent >= settings.whatsapp.maxMessagesPerLeadPer7Days) return { ok: false, reason: 'frequency_cap' };
    return { ok: true };
  }

  private async enqueue(input: { tenantId: string; leadId: string; templateId: string; purpose: WaPurpose; createdBy: string | null; automated: boolean; context?: Record<string, string> }): Promise<WhatsAppMessage> {
    const lead = await this.prisma.system.lead.findFirstOrThrow({ where: { id: input.leadId, tenantId: input.tenantId } });
    const template = await this.prisma.system.whatsAppTemplate.findFirstOrThrow({ where: { id: input.templateId, tenantId: input.tenantId } });
    const client = await this.client(input.tenantId);
    const policy: PolicyResult = client ? await this.policy(input.tenantId, lead, template, input.automated) : { ok: false, reason: 'not_configured' };
    const msg = await this.prisma.system.whatsAppMessage.create({
      data: {
        tenantId: input.tenantId,
        leadId: lead.id,
        phoneE164: lead.phoneE164,
        direction: 'OUTBOUND',
        purpose: input.purpose,
        templateId: template.id,
        templateName: template.name,
        status: policy.ok ? 'QUEUED' : 'SKIPPED',
        errorMessage: policy.ok ? null : policy.reason,
        isSimulated: client?.simulated ?? false,
        createdByMembershipId: input.createdBy,
        body: JSON.stringify({ context: input.context ?? {} }),
      },
    });
    if (policy.ok) await this.jobs.add('whatsapp.send', { tenantId: input.tenantId, messageId: msg.id }, { jobId: `wa-${msg.id}`, attempts: 4, backoff: { type: 'exponential', delay: 15_000 } });
    await this.prisma.system.leadActivity.create({
      data: { tenantId: input.tenantId, leadId: lead.id, type: policy.ok ? 'WHATSAPP_QUEUED' : 'WHATSAPP_SKIPPED', actorMembershipId: input.createdBy, data: { template: template.name, purpose: input.purpose, reason: policy.ok ? null : policy.reason } },
    });
    return msg;
  }

  async sendManual(ctx: RequestContext, leadId: string, templateId: string) {
    const leadWhere = await this.scope.leadWhere(ctx);
    const lead = await this.prisma.db.lead.findFirst({ where: { AND: [leadWhere, { id: leadId, tenantId: ctx.tenantId }], tenantId: ctx.tenantId } });
    if (!lead) throw Errors.notFound('Lead');
    const template = await this.prisma.db.whatsAppTemplate.findFirst({ where: { id: templateId, tenantId: ctx.tenantId } });
    if (!template) throw Errors.notFound('Template');
    const msg = await this.enqueue({ tenantId: ctx.tenantId, leadId, templateId, purpose: 'MANUAL', createdBy: ctx.membershipId, automated: false });
    if (msg.status === 'SKIPPED') throw Errors.conflict('WHATSAPP_BLOCKED', `Message not sent: ${msg.errorMessage?.replace(/_/g, ' ')}`);
    return msg;
  }

  /** Called after a wrap-up. Sends only what the tenant enabled, through utility templates, within policy. */
  async followUpForOutcome(tenantId: string, callId: string, outcomeCode: string): Promise<void> {
    const { settings } = await this.settings.get(tenantId);
    const purpose: WaPurpose | null =
      (outcomeCode === 'CALLBACK' || outcomeCode === 'FOLLOW_UP') && settings.whatsapp.sendCallbackConfirmation
        ? 'CALLBACK_CONFIRMATION'
        : (outcomeCode === 'NO_ANSWER' || outcomeCode === 'BUSY') && settings.whatsapp.sendMissedCallFollowup
          ? 'MISSED_CALL_FOLLOWUP'
          : null;
    if (!purpose) return;
    const template = await this.prisma.system.whatsAppTemplate.findFirst({ where: { tenantId, purpose, active: true } });
    if (!template) return;
    const call = await this.prisma.system.call.findUnique({ where: { id: callId }, include: { outcome: true } });
    if (!call) return;
    // At most one automated message per call.
    const already = await this.prisma.system.whatsAppMessage.count({ where: { tenantId, leadId: call.leadId, purpose, createdAt: { gte: call.initiatedAt } } });
    if (already) return;
    const context: Record<string, string> = {};
    if (call.outcome?.callbackAt) context.callbackAt = call.outcome.callbackAt.toISOString();
    await this.enqueue({ tenantId, leadId: call.leadId, templateId: template.id, purpose, createdBy: null, automated: true, context: { ...context, agentMembershipId: call.membershipId } });
  }

  /** Worker: deliver one queued message. Retryable provider errors are retried by BullMQ. */
  async deliver(tenantId: string, messageId: string): Promise<void> {
    const msg = await this.prisma.system.whatsAppMessage.findUnique({ where: { id: messageId } });
    if (!msg || msg.tenantId !== tenantId || msg.status !== 'QUEUED' || !msg.templateId) return;
    const [template, lead, tenant] = await Promise.all([
      this.prisma.system.whatsAppTemplate.findUnique({ where: { id: msg.templateId } }),
      msg.leadId ? this.prisma.system.lead.findUnique({ where: { id: msg.leadId } }) : null,
      this.prisma.system.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ]);
    if (!template || !lead) return void (await this.prisma.system.whatsAppMessage.update({ where: { id: messageId }, data: { status: 'FAILED', errorMessage: 'lead_or_template_missing', failedAt: new Date() } }));
    // Re-check opt-out at send time: it may have arrived after queueing.
    if (await this.compliance.isSuppressed(this.prisma.system, tenantId, lead.phoneE164, 'WHATSAPP')) {
      return void (await this.prisma.system.whatsAppMessage.update({ where: { id: messageId }, data: { status: 'SKIPPED', errorMessage: 'opted_out' } }));
    }
    const client = await this.client(tenantId);
    if (!client) return void (await this.prisma.system.whatsAppMessage.update({ where: { id: messageId }, data: { status: 'FAILED', errorMessage: 'not_configured', failedAt: new Date() } }));
    const ctx = JSON.parse(msg.body ?? '{}').context ?? {};
    const agentName = ctx.agentMembershipId
      ? ((await this.prisma.system.membership.findUnique({ where: { id: ctx.agentMembershipId }, include: { user: true } }))?.user.name ?? '')
      : '';
    const when = ctx.callbackAt ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: tenant.timezone }).format(new Date(ctx.callbackAt)) : '';
    const values: Record<string, string> = {
      'lead.fullName': lead.fullName,
      'lead.firstName': lead.fullName.split(/\s+/)[0] ?? lead.fullName,
      'callback.when': when,
      'org.name': tenant.name,
      'agent.name': agentName,
    };
    const params = ((template.variables as string[]) ?? []).map((v) => values[v] ?? '');
    try {
      const { messageId: providerMessageId } = await client.sendTemplate({ toE164: lead.phoneE164, templateName: template.name, language: template.language, bodyParams: params });
      await this.prisma.system.whatsAppMessage.update({ where: { id: messageId }, data: { status: 'SENT', providerMessageId, sentAt: new Date(), attempts: { increment: 1 } } });
      await this.prisma.system.usageLedgerEntry.upsert({
        where: { kind_sourceType_sourceId: { kind: 'WHATSAPP_MESSAGE', sourceType: 'whatsapp_message', sourceId: messageId } },
        create: { tenantId, kind: 'WHATSAPP_MESSAGE', quantity: 1n, isEstimate: client.simulated, sourceType: 'whatsapp_message', sourceId: messageId, occurredAt: new Date() },
        update: {},
      });
    } catch (err) {
      const e = err instanceof WhatsAppError ? err : new WhatsAppError((err as Error).message, null, true);
      await this.prisma.system.whatsAppMessage.update({
        where: { id: messageId },
        data: { attempts: { increment: 1 }, errorCode: e.code, errorMessage: e.message.slice(0, 500), ...(e.retryable ? {} : { status: 'FAILED', failedAt: new Date() }) },
      });
      await this.prisma.system.providerConfig.updateMany({ where: { tenantId, provider: 'WHATSAPP' }, data: { lastError: e.message.slice(0, 500) } });
      if (e.retryable) throw e;
    }
  }

  async markFailedAfterRetries(messageId: string, reason: string) {
    await this.prisma.system.whatsAppMessage.updateMany({ where: { id: messageId, status: 'QUEUED' }, data: { status: 'FAILED', failedAt: new Date(), errorMessage: reason.slice(0, 500) } });
  }

  async listMessages(ctx: RequestContext, leadId: string | undefined, page: number, pageSize: number) {
    if (leadId) {
      const leadWhere = await this.scope.leadWhere(ctx);
      const visible = await this.prisma.db.lead.findFirst({ where: { AND: [leadWhere, { id: leadId, tenantId: ctx.tenantId }], tenantId: ctx.tenantId }, select: { id: true } });
      if (!visible) throw Errors.notFound('Lead');
    } else if (ctx.role === 'AGENT') throw Errors.forbidden();
    const where = { tenantId: ctx.tenantId, ...(leadId ? { leadId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.db.whatsAppMessage.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(page, pageSize) }),
      this.prisma.db.whatsAppMessage.count({ where }),
    ]);
    return toPage(items.map((m) => ({ ...m, body: m.direction === 'INBOUND' ? m.body : null })), total, page, pageSize);
  }

  // ───── webhooks ─────
  async verifySubscription(tenantId: string, mode: string | undefined, token: string | undefined, challenge: string | undefined): Promise<string> {
    const loaded = await this.loadConfig(tenantId);
    const expected = loaded?.secrets.webhookVerifyToken;
    if (mode !== 'subscribe' || !expected || !token || !this.crypto.safeEqual(token, expected) || !challenge) throw Errors.forbidden('Verification failed');
    return challenge;
  }

  async handleWebhook(tenantId: string, rawBody: Buffer | undefined, signature: string | undefined, payload: unknown): Promise<void> {
    const loaded = await this.loadConfig(tenantId);
    if (!loaded?.secrets.appSecret || !verifyMetaSignature(rawBody, signature, loaded.secrets.appSecret)) {
      this.logger.warn(`Rejected WhatsApp webhook with invalid signature for tenant ${tenantId}`);
      throw Errors.forbidden('Invalid signature');
    }
    const entries = ((payload as { entry?: unknown[] })?.entry ?? []) as { changes?: { value?: Record<string, unknown> }[] }[];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        for (const s of (value.statuses ?? []) as { id: string; status: string; timestamp?: string; errors?: { code?: number; title?: string; message?: string }[] }[]) {
          await this.applyStatus(tenantId, s);
        }
        for (const m of (value.messages ?? []) as { from: string; id: string; type: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } } }[]) {
          await this.applyInbound(tenantId, m);
        }
      }
    }
  }

  private async applyStatus(tenantId: string, s: { id: string; status: string; timestamp?: string; errors?: { code?: number; title?: string; message?: string }[] }) {
    const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
    const map: Record<string, Partial<WhatsAppMessage>> = {
      sent: { status: 'SENT', sentAt: at },
      delivered: { status: 'DELIVERED', deliveredAt: at },
      read: { status: 'READ', readAt: at },
      failed: { status: 'FAILED', failedAt: at, errorCode: s.errors?.[0]?.code != null ? String(s.errors[0].code) : null, errorMessage: (s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? 'failed').slice(0, 500) },
    };
    const data = map[s.status];
    if (!data) return;
    const rank: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };
    const msg = await this.prisma.system.whatsAppMessage.findUnique({ where: { providerMessageId: s.id } });
    if (!msg || msg.tenantId !== tenantId) return;
    // Statuses can arrive out of order: never move backwards (failed always wins).
    if (data.status !== 'FAILED' && (rank[msg.status] ?? 0) >= (rank[data.status as string] ?? 0)) return;
    await this.prisma.system.whatsAppMessage.update({ where: { id: msg.id }, data });
  }

  private async applyInbound(tenantId: string, m: { from: string; id: string; type: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string } } }) {
    const phoneE164 = `+${m.from.replace(/^\+/, '')}`;
    const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? null;
    const lead = await this.prisma.system.lead.findFirst({ where: { tenantId, phoneE164 }, select: { id: true } });
    try {
      await this.prisma.system.whatsAppMessage.create({
        data: { tenantId, leadId: lead?.id ?? null, phoneE164, direction: 'INBOUND', status: 'RECEIVED', providerMessageId: m.id, body: text?.slice(0, 4000) ?? `[${m.type}]` },
      });
    } catch {
      return; // duplicate delivery of the same inbound message
    }
    if (isOptOut(text)) {
      await this.prisma.system.$transaction((tx) => this.compliance.suppress(tx, { tenantId, phoneE164, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'whatsapp_keyword', note: `Customer replied "${text}"` }));
      await this.audit.log({ tenantId, action: 'whatsapp.opt_out_received', entityType: 'lead', entityId: lead?.id });
    }
  }
}
