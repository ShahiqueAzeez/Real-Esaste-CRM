import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { permissionsFor, type MembershipRole } from '@crm/shared';
import type { Response } from 'express';
import { AppConfig } from '../../config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { AuthState } from '../../common/auth-context';

export const SESSION_COOKIE = 'crm_sid';
export const CSRF_COOKIE = 'crm_csrf';
const ABSOLUTE_MAX_MS = 7 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

/** Argon2id with library defaults (m=19 MiB, t=2, p=1), the OWASP minimum recommendation. */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(passwordHash: string | null | undefined, password: string): Promise<boolean> {
    if (!passwordHash) {
      // Equalize timing for unknown users.
      this.dummyHash ??= hash('timing-equalizer-password-1');
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}

export interface ResolvedSession extends AuthState {
  csrfTokenHash: string;
  blockedReason: 'TENANT_SUSPENDED' | 'MEMBERSHIP_DEACTIVATED' | null;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
  ) {}

  private ttlMs(): number {
    return this.config.env.SESSION_TTL_HOURS * 3600 * 1000;
  }

  async create(input: { userId: string; membershipId: string | null; ip?: string; userAgent?: string }): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
    const token = this.crypto.randomToken(32);
    const csrfToken = this.crypto.randomToken(24);
    const expiresAt = new Date(Date.now() + this.ttlMs());
    await this.prisma.system.session.create({
      data: {
        tokenHash: this.crypto.sha256(token),
        csrfTokenHash: this.crypto.sha256(csrfToken),
        userId: input.userId,
        membershipId: input.membershipId,
        ip: input.ip?.slice(0, 64),
        userAgent: input.userAgent?.slice(0, 300),
        expiresAt,
      },
    });
    return { token, csrfToken, expiresAt };
  }

  setCookies(res: Response, token: string, csrfToken: string, expiresAt: Date): void {
    const secure = this.config.env.COOKIE_SECURE;
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: expiresAt });
    res.cookie(CSRF_COOKIE, csrfToken, { httpOnly: false, secure, sameSite: 'lax', path: '/', expires: expiresAt });
  }

  setCsrfCookie(res: Response, csrfToken: string): void {
    res.cookie(CSRF_COOKIE, csrfToken, { httpOnly: false, secure: this.config.env.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: this.ttlMs() });
  }

  clearCookies(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  async rotateCsrf(sessionId: string): Promise<string> {
    const csrfToken = this.crypto.randomToken(24);
    await this.prisma.system.session.update({ where: { id: sessionId }, data: { csrfTokenHash: this.crypto.sha256(csrfToken) } });
    return csrfToken;
  }

  /** Resolve a raw session token into the authenticated user and active membership. */
  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const session = await this.prisma.system.session.findUnique({
      where: { tokenHash: this.crypto.sha256(token) },
      include: { user: true, membership: { include: { tenant: true } } },
    });
    const now = Date.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now) return null;

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const expiresAt = new Date(Math.min(now + this.ttlMs(), session.createdAt.getTime() + ABSOLUTE_MAX_MS));
      await this.prisma.system.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt } }).catch(() => undefined);
    }

    const { user, membership } = session;
    let blockedReason: ResolvedSession['blockedReason'] = null;
    let membershipCtx: AuthState['membership'] = null;
    if (membership) {
      if (membership.status !== 'ACTIVE') blockedReason = 'MEMBERSHIP_DEACTIVATED';
      else if (membership.tenant.status !== 'ACTIVE') blockedReason = 'TENANT_SUSPENDED';
      else {
        membershipCtx = {
          tenantId: membership.tenantId,
          tenantName: membership.tenant.name,
          timezone: membership.tenant.timezone,
          membershipId: membership.id,
          role: membership.role as MembershipRole,
          permissions: permissionsFor(membership.role as MembershipRole, membership.extraPermissions),
        };
      }
    }
    return {
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin },
      sessionId: session.id,
      membership: membershipCtx,
      csrfTokenHash: session.csrfTokenHash,
      blockedReason,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.system.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.system.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForMembership(membershipId: string): Promise<void> {
    await this.prisma.system.session.updateMany({ where: { membershipId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
