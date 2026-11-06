import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@crm/shared';
import { AppConfig } from '../../config/config';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { CSRF_COOKIE, SESSION_COOKIE, SessionService } from '../../modules/auth/session.service';
import { IS_PUBLIC, PERMISSIONS_KEY, PLATFORM_ONLY, SKIP_CSRF, type AuthedRequest } from '../auth-context';
import { Errors } from '../errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: authenticates the session cookie, enforces CSRF (double-submit token bound to the
 * session + Origin check) on unsafe methods, then platform-admin and permission requirements.
 * Authorization is always decided here on the server; the UI only hides controls.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const resolved = token ? await this.sessions.resolve(token) : null;
    if (resolved) req.auth = { user: resolved.user, sessionId: resolved.sessionId, membership: resolved.membership };
    if (isPublic) return true;
    if (!resolved) throw Errors.unauthorized();

    if (!SAFE_METHODS.has(req.method) && !this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, targets)) {
      this.checkOrigin(req);
      const header = req.headers['x-csrf-token'];
      const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
      if (typeof header !== 'string' || !cookie || header !== cookie || !this.crypto.safeEqual(this.crypto.sha256(header), resolved.csrfTokenHash)) {
        throw Errors.forbidden('Security token missing or expired. Reload the page and try again.');
      }
    }

    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ONLY, targets)) {
      if (!resolved.user.isPlatformAdmin) throw Errors.forbidden();
      return true;
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, targets);
    if (required && required.length > 0) {
      if (!resolved.membership) {
        if (resolved.blockedReason === 'TENANT_SUSPENDED') throw Errors.forbidden('This organization is suspended. Contact support.');
        if (resolved.blockedReason === 'MEMBERSHIP_DEACTIVATED') throw Errors.forbidden('Your access to this organization was removed.');
        throw Errors.forbidden('Select an organization first');
      }
      for (const p of required) if (!resolved.membership.permissions.has(p)) throw Errors.forbidden();
    }
    return true;
  }

  private checkOrigin(req: AuthedRequest): void {
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients; CSRF token still required
    const allowed = [...this.config.env.WEB_ORIGIN, new URL(this.config.env.PUBLIC_BASE_URL).origin];
    if (!allowed.includes(origin.replace(/\/+$/, ''))) throw Errors.forbidden('Request origin not allowed');
  }
}
