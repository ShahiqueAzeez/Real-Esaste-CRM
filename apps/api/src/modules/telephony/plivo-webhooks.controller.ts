import { Controller, Header, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { isTerminalCall, isTerminalLeg, parseTenantSettings, type CallStatus } from '@crm/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppConfig } from '../../config/config';
import { Public, SkipCsrf } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CallLifecycleService } from '../calls/call-lifecycle.service';
import { plivoLegEvent, plivoMpcEvent, plivoParticipantEvent, plivoRecordingEvent, verifyPlivoSignature, type PlivoParams } from './plivo-events';
import { PlivoProvider } from './plivo.provider';
import { TelephonyRegistry } from './registry.service';

const idsSchema = z.object({ callId: z.uuid(), legId: z.uuid(), role: z.enum(['agent', 'customer', 'supervisor']).optional() });

/**
 * Plivo callbacks. Each request is resolved to a call leg from the query string, verified with
 * Plivo's V3 signature using that tenant's auth token, stored once and applied idempotently.
 */
@ApiExcludeController()
@Public()
@SkipCsrf()
@Throttle({ default: { limit: 3000, ttl: 60_000 } })
@Controller('webhooks/plivo')
export class PlivoWebhooksController {
  private readonly logger = new Logger('PlivoWebhooks');

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: TelephonyRegistry,
    private readonly lifecycle: CallLifecycleService,
    private readonly config: AppConfig,
  ) {}

  private async authenticate(req: Request, query: unknown) {
    const parsed = idsSchema.safeParse(query);
    if (!parsed.success) throw Errors.notFound();
    const { callId, legId, role } = parsed.data;
    const leg = await this.prisma.system.callLeg.findUnique({ where: { id: legId }, include: { call: true } });
    if (!leg || leg.callId !== callId || leg.provider !== 'PLIVO' || (role && leg.role.toLowerCase() !== role)) throw Errors.notFound();
    const { authTokens, provider } = await this.registry.resolve(leg.tenantId);
    const valid = verifyPlivoSignature({
      method: 'POST',
      url: `${this.config.env.PUBLIC_BASE_URL}${req.originalUrl}`,
      params: (req.body ?? {}) as Record<string, unknown>,
      headers: req.headers,
      authTokens,
    });
    if (!valid) {
      this.logger.warn(`Rejected Plivo callback with invalid signature for leg ${legId}`);
      throw Errors.forbidden('Invalid signature');
    }
    return { leg, call: leg.call, ids: { tenantId: leg.tenantId, callId, legId }, costCurrency: provider?.costCurrency ?? null };
  }

  @Post('answer')
  @HttpCode(200)
  @Header('Content-Type', 'application/xml')
  async answer(@Req() req: Request, @Query() query: unknown): Promise<string> {
    const { leg, call, ids } = await this.authenticate(req, query);
    const params = req.body as PlivoParams;
    // Refuse to bridge anything that is no longer wanted.
    if (isTerminalCall(call.status as CallStatus) || isTerminalLeg(leg.status)) return PlivoProvider.hangupXml();
    await this.lifecycle.ingest(plivoLegEvent('answer', params, ids, true));
    const tenant = await this.prisma.system.tenant.findUniqueOrThrow({ where: { id: call.tenantId }, select: { settings: true } });
    const settings = parseTenantSettings(tenant.settings);
    try {
      return this.buildAnswer(call, leg, settings);
    } catch (err) {
      // Never leave Plivo without valid XML: end the leg and surface the configuration problem.
      this.logger.error(`Could not build answer XML for leg ${leg.id}: ${(err as Error).message}. Check PUBLIC_BASE_URL is a public https URL.`);
      return PlivoProvider.hangupXml('error');
    }
  }

  private buildAnswer(call: { id: string; recordingEnabled: boolean }, leg: { id: string; role: string }, settings: ReturnType<typeof parseTenantSettings>): string {
    return PlivoProvider.answerXml({
      role: leg.role === 'AGENT' ? 'agent' : leg.role === 'CUSTOMER' ? 'customer' : 'supervisor',
      mpcName: PlivoProvider.mpcName(call.id),
      statusCallbackUrl: this.config.webhookUrl(`/plivo/mpc?callId=${call.id}&legId=${leg.id}`),
      recording: {
        enabled: call.recordingEnabled,
        callbackUrl: this.config.webhookUrl(`/plivo/recording?callId=${call.id}&legId=${leg.id}`),
        notice: call.recordingEnabled && settings.recording.playNotice ? settings.recording.noticeText : null,
      },
      maxDurationSeconds: settings.calling.maxCallMinutes * 60,
    });
  }

  @Post('ring')
  @HttpCode(200)
  async ring(@Req() req: Request, @Query() query: unknown) {
    const { ids } = await this.authenticate(req, query);
    const r = await this.lifecycle.ingest(plivoLegEvent('ring', req.body as PlivoParams, ids, true));
    return { ok: true, duplicate: r.duplicate };
  }

  @Post('hangup')
  @HttpCode(200)
  async hangup(@Req() req: Request, @Query() query: unknown) {
    const { ids, costCurrency } = await this.authenticate(req, query);
    const r = await this.lifecycle.ingest({ ...plivoLegEvent('hangup', req.body as PlivoParams, ids, true), costCurrency });
    return { ok: true, duplicate: r.duplicate };
  }

  /** Only used by Plivo when the answer URL fails; end the leg cleanly. */
  @Post('fallback')
  @HttpCode(200)
  @Header('Content-Type', 'application/xml')
  async fallback(@Req() req: Request, @Query() query: unknown) {
    const { ids } = await this.authenticate(req, query);
    this.logger.error(`Plivo used the fallback URL for leg ${ids.legId}; the answer URL failed`);
    return PlivoProvider.hangupXml('error');
  }

  @Post('mpc')
  @HttpCode(200)
  async mpc(@Req() req: Request, @Query() query: unknown) {
    const { ids } = await this.authenticate(req, query);
    await this.lifecycle.ingest(plivoMpcEvent(req.body as PlivoParams, ids, true));
    return { ok: true };
  }

  @Post('recording')
  @HttpCode(200)
  async recording(@Req() req: Request, @Query() query: unknown) {
    const { ids } = await this.authenticate(req, query);
    const evt = plivoRecordingEvent(req.body as PlivoParams, ids, true);
    if (evt) await this.lifecycle.ingest(evt);
    else this.logger.warn(`Recording callback without a recording id for call ${ids.callId}`);
    return { ok: true };
  }

  @Post('participant')
  @HttpCode(200)
  async participant(@Req() req: Request, @Query() query: unknown, @Res({ passthrough: true }) _res: Response) {
    const { ids } = await this.authenticate(req, query);
    const evt = plivoParticipantEvent(req.body as PlivoParams, ids, true);
    if (evt) await this.lifecycle.ingest(evt);
    return { ok: true };
  }
}
