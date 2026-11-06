import { Injectable } from '@nestjs/common';
import { GRANTABLE_EXTRA_PERMISSIONS, type inviteMemberSchema, type teamSchema, type updateMemberSchema } from '@crm/shared';
import { normalizePhone } from '@crm/shared/phone';
import type { z } from 'zod';
import { AppConfig } from '../../config/config';
import type { RequestContext } from '../../common/auth-context';
import { Errors } from '../../common/errors';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { MailService } from '../../infra/mail/mail.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RealtimeService } from '../../infra/realtime/realtime.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { EntitlementsService } from '../org/org-core.service';

const INVITE_DAYS = 7;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly realtime: RealtimeService,
    private readonly config: AppConfig,
  ) {}

  async listMembers(ctx: RequestContext) {
    const rows = await this.prisma.db.membership.findMany({
      where: { tenantId: ctx.tenantId },
      include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } }, team: { select: { id: true, name: true } }, agentState: true },
      orderBy: [{ status: 'asc' }, { role: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((m) => this.present(m));
  }

  private present(m: Awaited<ReturnType<UsersService['findMember']>>) {
    return {
      id: m.id,
      role: m.role,
      status: m.status,
      user: m.user,
      team: m.team,
      extraPermissions: m.extraPermissions,
      callingMode: m.callingMode,
      agentPhoneE164: m.agentPhoneE164,
      telephonyIdentity: m.telephonyIdentity,
      agentState: m.agentState ? { status: m.agentState.status, statusChangedAt: m.agentState.statusChangedAt, pauseReason: m.agentState.pauseReason } : null,
      createdAt: m.createdAt,
    };
  }

  private async findMember(ctx: RequestContext, id: string) {
    const m = await this.prisma.db.membership.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } }, team: { select: { id: true, name: true } }, agentState: true },
    });
    if (!m) throw Errors.notFound('Member');
    return m;
  }

  async getMember(ctx: RequestContext, id: string) {
    return this.present(await this.findMember(ctx, id));
  }

  async updateMember(ctx: RequestContext, id: string, body: z.output<typeof updateMemberSchema>) {
    const m = await this.findMember(ctx, id);
    if (m.id === ctx.membershipId && (body.status === 'DEACTIVATED' || (body.role && body.role !== m.role))) {
      throw Errors.badRequest('SELF_CHANGE', 'You cannot change your own role or deactivate yourself');
    }
    const demotingAdmin = m.role === 'ORG_ADMIN' && ((body.role && body.role !== 'ORG_ADMIN') || body.status === 'DEACTIVATED');
    if (demotingAdmin) {
      const admins = await this.prisma.db.membership.count({ where: { tenantId: ctx.tenantId, role: 'ORG_ADMIN', status: 'ACTIVE' } });
      if (admins <= 1) throw Errors.conflict('LAST_ADMIN', 'An organization needs at least one active administrator');
    }
    const becomingActiveAgent =
      (body.status === 'ACTIVE' && m.status !== 'ACTIVE' && (body.role ?? m.role) === 'AGENT') || (body.role === 'AGENT' && m.role !== 'AGENT' && m.status === 'ACTIVE');
    if (becomingActiveAgent) await this.entitlements.assertAgentSeat(ctx.tenantId);
    if (body.teamId) {
      const team = await this.prisma.db.team.findFirst({ where: { id: body.teamId, tenantId: ctx.tenantId } });
      if (!team) throw Errors.badRequest('TEAM_NOT_FOUND', 'Team not found');
    }
    let agentPhoneE164: string | null | undefined;
    if (body.agentPhone !== undefined) {
      if (!body.agentPhone) agentPhoneE164 = null;
      else {
        const parsed = normalizePhone(body.agentPhone, 'IN');
        if (!parsed.ok) throw Errors.badRequest('INVALID_PHONE', 'Enter a valid phone number for the agent');
        agentPhoneE164 = parsed.value.e164;
      }
    }
    const extra = body.extraPermissions?.filter((p) => (GRANTABLE_EXTRA_PERMISSIONS as string[]).includes(p));
    const updated = await this.prisma.db.membership.update({
      where: { id: m.id, tenantId: ctx.tenantId },
      data: {
        role: body.role,
        status: body.status,
        teamId: body.teamId === undefined ? undefined : body.teamId,
        extraPermissions: extra,
        callingMode: body.callingMode === undefined ? undefined : body.callingMode,
        agentPhoneE164,
        telephonyIdentity: body.telephonyIdentity,
      },
    });
    if (body.status === 'DEACTIVATED' || (body.role && body.role !== m.role)) {
      await this.sessions.revokeAllForMembership(m.id);
      await this.prisma.db.agentState.updateMany({ where: { membershipId: m.id, tenantId: ctx.tenantId, currentCallId: null }, data: { status: 'OFFLINE', statusChangedAt: new Date() } });
    }
    await this.audit.fromCtx(ctx, 'member.updated', 'membership', m.id, {
      changes: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined),
    });
    return this.getMember(ctx, updated.id);
  }

  /**
   * Admin-generated password reset link for deployments without email. Refused for users who also
   * belong to other organizations or are platform admins, so one tenant can never take over an
   * account that has access elsewhere.
   */
  async resetLink(ctx: RequestContext, id: string) {
    const m = await this.findMember(ctx, id);
    const user = await this.prisma.system.user.findUniqueOrThrow({ where: { id: m.userId }, include: { memberships: { where: { status: 'ACTIVE' } } } });
    if (user.isPlatformAdmin || user.memberships.some((x) => x.tenantId !== ctx.tenantId)) {
      throw Errors.forbidden('This user belongs to other organizations; they must use "Forgot password" themselves.');
    }
    const token = await this.auth.issueToken(user.id, 'PASSWORD_RESET', 60);
    await this.audit.fromCtx(ctx, 'member.reset_link_created', 'membership', m.id);
    return { link: `${this.config.env.WEB_ORIGIN[0]}/reset-password/${token}`, expiresInMinutes: 60 };
  }

  // ───── invitations ─────

  listInvitations(ctx: RequestContext) {
    return this.prisma.db.invitation.findMany({
      where: { tenantId: ctx.tenantId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, teamId: true, expiresAt: true, createdAt: true },
    });
  }

  async invite(ctx: RequestContext, body: z.output<typeof inviteMemberSchema>) {
    await this.entitlements.assertOperational(ctx.tenantId);
    if (body.role === 'AGENT') await this.entitlements.assertAgentSeat(ctx.tenantId);
    const existingUser = await this.prisma.system.user.findUnique({ where: { email: body.email } });
    if (existingUser) {
      const member = await this.prisma.db.membership.findFirst({ where: { tenantId: ctx.tenantId, userId: existingUser.id, status: 'ACTIVE' } });
      if (member) throw Errors.conflict('ALREADY_MEMBER', 'This person is already a member of your organization');
    }
    if (body.teamId) {
      const team = await this.prisma.db.team.findFirst({ where: { id: body.teamId, tenantId: ctx.tenantId } });
      if (!team) throw Errors.badRequest('TEAM_NOT_FOUND', 'Team not found');
    }
    await this.prisma.db.invitation.updateMany({ where: { tenantId: ctx.tenantId, email: body.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    return this.createInvitation(ctx.tenantId, ctx.tenantName, body.email, body.role, body.teamId ?? null, ctx.membershipId, ctx);
  }

  async createInvitation(tenantId: string, tenantName: string, email: string, role: 'ORG_ADMIN' | 'SUPERVISOR' | 'AGENT', teamId: string | null, invitedBy: string | null, ctx?: RequestContext) {
    const token = this.crypto.randomToken(32);
    const invitation = await this.prisma.system.invitation.create({
      data: { tenantId, email, role, teamId, tokenHash: this.crypto.sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86400_000), invitedByMembership: invitedBy },
      select: { id: true, email: true, role: true, teamId: true, expiresAt: true, createdAt: true },
    });
    const link = `${this.config.env.WEB_ORIGIN[0]}/invite/${token}`;
    const { delivered } = await this.mail.send({
      tenantId,
      to: email,
      subject: `You're invited to ${tenantName}`,
      text: `You have been invited to join ${tenantName} on Calling CRM as ${role.replace('_', ' ').toLowerCase()}.\n\nAccept within ${INVITE_DAYS} days:\n${link}`,
    });
    if (ctx) await this.audit.fromCtx(ctx, 'member.invited', 'invitation', invitation.id, { role });
    // Without email delivery the inviter must share the link through another channel.
    return { invitation, emailDelivered: delivered, inviteLink: delivered ? null : link };
  }

  async revokeInvitation(ctx: RequestContext, id: string) {
    const res = await this.prisma.db.invitation.updateMany({ where: { id, tenantId: ctx.tenantId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw Errors.notFound('Invitation');
    await this.audit.fromCtx(ctx, 'member.invitation_revoked', 'invitation', id);
  }

  async resendInvitation(ctx: RequestContext, id: string) {
    const inv = await this.prisma.db.invitation.findFirst({ where: { id, tenantId: ctx.tenantId, acceptedAt: null, revokedAt: null } });
    if (!inv) throw Errors.notFound('Invitation');
    await this.prisma.db.invitation.update({ where: { id: inv.id, tenantId: ctx.tenantId }, data: { revokedAt: new Date() } });
    return this.createInvitation(ctx.tenantId, ctx.tenantName, inv.email, inv.role, inv.teamId, ctx.membershipId, ctx);
  }

  // ───── teams ─────

  async listTeams(ctx: RequestContext) {
    const teams = await this.prisma.db.team.findMany({
      where: { tenantId: ctx.tenantId },
      include: {
        supervisors: { include: { membership: { include: { user: { select: { name: true } } } } } },
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    });
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      memberCount: t._count.members,
      supervisors: t.supervisors.map((s) => ({ membershipId: s.membershipId, name: s.membership.user.name })),
    }));
  }

  async saveTeam(ctx: RequestContext, body: z.output<typeof teamSchema>, id?: string) {
    const supervisors = await this.prisma.db.membership.findMany({ where: { tenantId: ctx.tenantId, id: { in: body.supervisorIds }, role: { in: ['SUPERVISOR', 'ORG_ADMIN'] } } });
    if (supervisors.length !== body.supervisorIds.length) throw Errors.badRequest('INVALID_SUPERVISOR', 'Supervisors must be supervisor or admin members');
    const team = await this.prisma.db.$transaction(async (tx) => {
      const t = id
        ? await tx.team.update({ where: { id, tenantId: ctx.tenantId }, data: { name: body.name } })
        : await tx.team.create({ data: { tenantId: ctx.tenantId, name: body.name } });
      await tx.teamSupervisor.deleteMany({ where: { tenantId: ctx.tenantId, teamId: t.id } });
      if (body.supervisorIds.length) {
        await tx.teamSupervisor.createMany({ data: body.supervisorIds.map((membershipId) => ({ tenantId: ctx.tenantId, teamId: t.id, membershipId })) });
      }
      return t;
    });
    await this.audit.fromCtx(ctx, id ? 'team.updated' : 'team.created', 'team', team.id);
    return team;
  }

  async deleteTeam(ctx: RequestContext, id: string) {
    const res = await this.prisma.db.team.deleteMany({ where: { id, tenantId: ctx.tenantId } });
    if (res.count === 0) throw Errors.notFound('Team');
    await this.audit.fromCtx(ctx, 'team.deleted', 'team', id);
  }
}
