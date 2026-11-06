import { Controller, Delete, Get, HttpCode, Logger, Module, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Ctx, Public, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { UuidParam } from '../../common/pipes/zod';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ScopeService } from '../org/org-core.service';
import { TelephonyRegistry } from '../telephony/registry.service';

const PLAYBACK_TTL_SECONDS = 300;

/**
 * Recording access. Browsers get a 5-minute signed URL to this API, which checks the token and
 * streams the media from the provider with server-side credentials. Provider URLs never leave the
 * server, and every access is audited.
 */
@ApiTags('recordings')
@Controller('recordings')
export class RecordingsController {
  private readonly logger = new Logger('Recordings');
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly crypto: CryptoService,
    private readonly registry: TelephonyRegistry,
    private readonly audit: AuditService,
  ) {}

  private async findVisible(ctx: RequestContext, id: string) {
    const rec = await this.prisma.db.recording.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!rec) throw Errors.notFound('Recording');
    const callWhere = await this.scope.callWhere(ctx);
    const visible = await this.prisma.db.call.findFirst({ where: { tenantId: ctx.tenantId, AND: [callWhere, { id: rec.callId, tenantId: ctx.tenantId }] }, select: { id: true } });
    if (!visible) throw Errors.notFound('Recording');
    return rec;
  }

  @Post(':id/playback')
  @RequirePermissions('recordings:play')
  @HttpCode(200)
  async playback(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    const rec = await this.findVisible(ctx, id);
    if (rec.status !== 'AVAILABLE') throw Errors.conflict('RECORDING_UNAVAILABLE', rec.status === 'DELETED' ? 'This recording was deleted' : 'The recording is not available yet');
    const token = this.crypto.sign({ rid: rec.id, tid: ctx.tenantId, mid: ctx.membershipId }, PLAYBACK_TTL_SECONDS);
    await this.audit.fromCtx(ctx, 'recording.accessed', 'recording', rec.id, { callId: rec.callId });
    return { url: `/api/recordings/stream/${token}`, expiresAt: new Date(Date.now() + PLAYBACK_TTL_SECONDS * 1000) };
  }

  @Public()
  @SkipThrottle()
  @Get('stream/:token')
  async stream(@Param('token') token: string, @Res() res: Response) {
    const claims = this.crypto.verify<{ rid: string; tid: string; mid: string }>(token);
    if (!claims) throw Errors.forbidden('This playback link has expired. Open the recording again.');
    const membership = await this.prisma.system.membership.findFirst({ where: { id: claims.mid, tenantId: claims.tid, status: 'ACTIVE' } });
    const rec = await this.prisma.system.recording.findFirst({ where: { id: claims.rid, tenantId: claims.tid, status: 'AVAILABLE' } });
    if (!membership || !rec) throw Errors.notFound('Recording');
    try {
      const provider = await this.registry.forCall(rec.tenantId, rec.provider);
      const media = await provider.fetchRecording({ providerRecordingId: rec.providerRecordingId, providerUrl: rec.providerUrl });
      res.setHeader('Content-Type', media.contentType);
      if (media.contentLength) res.setHeader('Content-Length', String(media.contentLength));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline');
      media.body.pipe(res);
    } catch (err) {
      this.logger.warn(`Recording ${rec.id} stream failed: ${(err as Error).message}`);
      throw Errors.unavailable('RECORDING_FETCH_FAILED', 'The provider could not return this recording right now');
    }
  }

  @Delete(':id')
  @RequirePermissions('recordings:delete')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    const rec = await this.findVisible(ctx, id);
    if (rec.status === 'DELETED') return;
    const provider = await this.registry.forCall(rec.tenantId, rec.provider);
    await provider.deleteRecording(rec.providerRecordingId);
    await this.prisma.db.recording.update({ where: { id: rec.id, tenantId: ctx.tenantId }, data: { status: 'DELETED', deletedAt: new Date(), deletedByMembershipId: ctx.membershipId, providerUrl: null } });
    await this.audit.fromCtx(ctx, 'recording.deleted', 'recording', rec.id, { callId: rec.callId });
  }

  @Get()
  @RequirePermissions('recordings:play')
  async list(@Ctx() ctx: RequestContext) {
    const callWhere = await this.scope.callWhere(ctx);
    return this.prisma.db.recording.findMany({
      where: { tenantId: ctx.tenantId, call: { tenantId: ctx.tenantId, AND: [callWhere] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, callId: true, status: true, durationSeconds: true, createdAt: true, retentionUntil: true },
    });
  }
}

@Module({ controllers: [RecordingsController] })
export class RecordingsModule {}
