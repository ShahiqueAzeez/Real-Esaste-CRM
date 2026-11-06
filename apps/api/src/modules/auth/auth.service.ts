import { Injectable, Logger } from '@nestjs/common';
import { permissionsFor, type MembershipRole } from '@crm/shared';
import { AppConfig } from '../../config/config';
import { Errors } from '../../common/errors';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { MailService } from '../../infra/mail/mail.service';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { PasswordService, SessionService } from './session.service';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export interface MeResponse {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; emailVerified: boolean };
  membership: null | {
    id: string;
    role: MembershipRole;
    permissions: string[];
    tenant: { id: string; name: string; slug: string; timezone: string };
  };
  memberships: { id: string; role: string; tenantId: string; tenantName: string; tenantStatus: string }[];
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
    private readonly config: AppConfig,
  ) {}

  private webUrl(path: string): string {
    return `${this.config.env.WEB_ORIGIN[0]}${path}`;
  }

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }) {
    const user = await this.prisma.system.user.findUnique({ where: { email } });
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await this.passwords.verify(null, password);
      throw Errors.tooMany('Too many failed sign-in attempts. Try again in a few minutes.');
    }
    const ok = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !ok) {
      if (user) {
        const failed = user.failedLoginCount + 1;
        const lock = failed >= MAX_FAILED_LOGINS;
        await this.prisma.system.user.update({
          where: { id: user.id },
          data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil },
        });
        await this.audit.log({ actorUserId: user.id, action: lock ? 'auth.locked' : 'auth.login_failed', ip: meta.ip });
      }
      throw Errors.unauthorized('Invalid email or password');
    }

    const memberships = await this.activeMemberships(user.id);
    if (memberships.length === 0 && !user.isPlatformAdmin) {
      throw Errors.forbidden('Your account is not active in any organization. Contact your administrator.');
    }
    await this.prisma.system.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    // Bind to the only membership automatically; otherwise the user picks one.
    const membershipId = memberships.length === 1 ? memberships[0]!.id : null;
    const session = await this.sessions.create({ userId: user.id, membershipId, ...meta });
    await this.audit.log({ tenantId: memberships.length === 1 ? memberships[0]!.tenantId : null, actorUserId: user.id, actorMembershipId: membershipId, action: 'auth.login', ip: meta.ip });
    return session;
  }

  private activeMemberships(userId: string) {
    return this.prisma.system.membership.findMany({
      where: { userId, status: 'ACTIVE', tenant: { status: 'ACTIVE' } },
      include: { tenant: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async me(userId: string, sessionMembershipId: string | null): Promise<MeResponse> {
    const user = await this.prisma.system.user.findUniqueOrThrow({ where: { id: userId } });
    const all = await this.prisma.system.membership.findMany({ where: { userId, status: 'ACTIVE' }, include: { tenant: true }, orderBy: { createdAt: 'asc' } });
    const current = all.find((m) => m.id === sessionMembershipId && m.tenant.status === 'ACTIVE');
    return {
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin, emailVerified: !!user.emailVerifiedAt },
      membership: current
        ? {
            id: current.id,
            role: current.role as MembershipRole,
            permissions: [...permissionsFor(current.role as MembershipRole, current.extraPermissions)],
            tenant: { id: current.tenant.id, name: current.tenant.name, slug: current.tenant.slug, timezone: current.tenant.timezone },
          }
        : null,
      memberships: all.map((m) => ({ id: m.id, role: m.role, tenantId: m.tenantId, tenantName: m.tenant.name, tenantStatus: m.tenant.status })),
    };
  }

  /** Switch the session to another organization the user belongs to. Validated server-side. */
  async selectMembership(userId: string, sessionId: string, membershipId: string) {
    const membership = await this.prisma.system.membership.findFirst({
      where: { id: membershipId, userId, status: 'ACTIVE', tenant: { status: 'ACTIVE' } },
    });
    if (!membership) throw Errors.forbidden('You do not have access to that organization');
    await this.prisma.system.session.update({ where: { id: sessionId }, data: { membershipId } });
    await this.audit.log({ tenantId: membership.tenantId, actorUserId: userId, actorMembershipId: membershipId, action: 'auth.select_org' });
    return this.sessions.rotateCsrf(sessionId);
  }

  async changePassword(userId: string, sessionId: string, current: string, next: string) {
    const user = await this.prisma.system.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await this.passwords.verify(user.passwordHash, current))) throw Errors.badRequest('WRONG_PASSWORD', 'Current password is incorrect');
    await this.prisma.system.user.update({ where: { id: userId }, data: { passwordHash: await this.passwords.hash(next) } });
    await this.sessions.revokeAllForUser(userId, sessionId);
    await this.audit.log({ actorUserId: userId, action: 'auth.password_changed' });
  }

  async issueToken(userId: string, type: 'PASSWORD_RESET' | 'EMAIL_VERIFICATION', ttlMinutes: number): Promise<string> {
    const token = this.crypto.randomToken(32);
    await this.prisma.system.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
    await this.prisma.system.authToken.create({
      data: { userId, type, tokenHash: this.crypto.sha256(token), expiresAt: new Date(Date.now() + ttlMinutes * 60_000) },
    });
    return token;
  }

  /** Always succeeds from the caller's point of view so accounts cannot be enumerated. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.system.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) return;
    const token = await this.issueToken(user.id, 'PASSWORD_RESET', 60);
    const link = this.webUrl(`/reset-password/${token}`);
    const { delivered } = await this.mail.send({
      to: user.email,
      subject: 'Reset your password',
      text: `Hello ${user.name},\n\nUse this link within 60 minutes to set a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`,
    });
    if (!delivered && !this.config.isProduction) this.logger.warn(`Email not configured. Development reset link: ${link}`);
    await this.audit.log({ actorUserId: user.id, action: 'auth.password_reset_requested' });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const row = await this.prisma.system.authToken.findUnique({ where: { tokenHash: this.crypto.sha256(token) } });
    if (!row || row.type !== 'PASSWORD_RESET' || row.usedAt || row.expiresAt < new Date()) {
      throw Errors.badRequest('INVALID_TOKEN', 'This reset link is invalid or has expired');
    }
    await this.prisma.system.$transaction([
      this.prisma.system.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.system.user.update({
        where: { id: row.userId },
        data: { passwordHash: await this.passwords.hash(password), failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: new Date() },
      }),
    ]);
    await this.sessions.revokeAllForUser(row.userId);
    await this.audit.log({ actorUserId: row.userId, action: 'auth.password_reset' });
  }

  async requestEmailVerification(userId: string): Promise<{ delivered: boolean }> {
    const user = await this.prisma.system.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return { delivered: false };
    const token = await this.issueToken(userId, 'EMAIL_VERIFICATION', 24 * 60);
    return this.mail.send({ to: user.email, subject: 'Verify your email address', text: `Confirm your email address:\n${this.webUrl(`/verify-email/${token}`)}` });
  }

  async confirmEmail(token: string): Promise<void> {
    const row = await this.prisma.system.authToken.findUnique({ where: { tokenHash: this.crypto.sha256(token) } });
    if (!row || row.type !== 'EMAIL_VERIFICATION' || row.usedAt || row.expiresAt < new Date()) {
      throw Errors.badRequest('INVALID_TOKEN', 'This verification link is invalid or has expired');
    }
    await this.prisma.system.$transaction([
      this.prisma.system.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.system.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
  }

  private async findInvitation(token: string) {
    const invitation = await this.prisma.system.invitation.findUnique({ where: { tokenHash: this.crypto.sha256(token) }, include: { tenant: true } });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date() || invitation.tenant.status !== 'ACTIVE') {
      throw Errors.badRequest('INVALID_INVITATION', 'This invitation is invalid, already used or expired');
    }
    return invitation;
  }

  async describeInvitation(token: string) {
    const inv = await this.findInvitation(token);
    const user = await this.prisma.system.user.findUnique({ where: { email: inv.email } });
    return { email: inv.email, role: inv.role, organization: inv.tenant.name, accountExists: !!user?.passwordHash, expiresAt: inv.expiresAt };
  }

  /**
   * Accept an invitation. New users choose a name and password. Existing users must confirm their
   * current password, so an invitation link alone never grants access to an existing account.
   */
  async acceptInvitation(token: string, name: string, password: string, meta: { ip?: string; userAgent?: string }) {
    const inv = await this.findInvitation(token);
    const result = await this.prisma.system.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: inv.email } });
      let userId: string;
      if (existing?.passwordHash) {
        if (!(await this.passwords.verify(existing.passwordHash, password))) {
          throw Errors.badRequest('WRONG_PASSWORD', 'This email already has an account. Enter its current password to accept.');
        }
        userId = existing.id;
        if (!existing.emailVerifiedAt) await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      } else {
        const hashed = await this.passwords.hash(password);
        const user = existing
          ? await tx.user.update({ where: { id: existing.id }, data: { name, passwordHash: hashed, emailVerifiedAt: new Date() } })
          : await tx.user.create({ data: { email: inv.email, name, passwordHash: hashed, emailVerifiedAt: new Date() } });
        userId = user.id;
      }
      if (inv.role === 'AGENT') await this.assertAgentSeat(tx, inv.tenantId);
      const membership = await this.provisioning.addMembership(tx, { tenantId: inv.tenantId, userId, role: inv.role as MembershipRole, teamId: inv.teamId });
      await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
      return { userId, membership };
    });
    await this.audit.log({ tenantId: inv.tenantId, actorUserId: result.userId, actorMembershipId: result.membership.id, action: 'member.joined', entityType: 'membership', entityId: result.membership.id, metadata: { role: inv.role } });
    return this.sessions.create({ userId: result.userId, membershipId: result.membership.id, ...meta });
  }

  private async assertAgentSeat(tx: Tx, tenantId: string) {
    const sub = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (!sub) return;
    const agents = await tx.membership.count({ where: { tenantId, role: 'AGENT', status: 'ACTIVE' } });
    if (agents >= sub.plan.maxAgents) {
      throw Errors.conflict('AGENT_LIMIT_REACHED', `Your plan allows ${sub.plan.maxAgents} active agents. Ask an administrator to upgrade or deactivate an agent.`);
    }
  }
}
