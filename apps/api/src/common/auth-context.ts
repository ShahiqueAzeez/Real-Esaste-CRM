import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { MembershipRole, Permission } from '@crm/shared';
import type { Request } from 'express';
import { Errors } from './errors';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

/** Tenant-scoped request context. tenantId comes only from the authenticated session. */
export interface RequestContext {
  user: AuthUser;
  sessionId: string;
  tenantId: string;
  tenantName: string;
  timezone: string;
  membershipId: string;
  role: MembershipRole;
  permissions: ReadonlySet<Permission>;
  ip?: string;
}

export interface AuthState {
  user: AuthUser;
  sessionId: string;
  membership: Omit<RequestContext, 'user' | 'sessionId' | 'ip'> | null;
}

export type AuthedRequest = Request & { auth?: AuthState };

export const IS_PUBLIC = 'crm:isPublic';
export const PERMISSIONS_KEY = 'crm:permissions';
export const PLATFORM_ONLY = 'crm:platformOnly';
export const SKIP_CSRF = 'crm:skipCsrf';

/** Route needs no session (login, invitation acceptance, webhooks, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route requires all listed permissions in the active tenant. */
export const RequirePermissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS_KEY, perms);
/** Route requires the platform super-admin flag. */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ONLY, true);
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);

export function requireTenantContext(req: AuthedRequest): RequestContext {
  const auth = req.auth;
  if (!auth) throw Errors.unauthorized();
  if (!auth.membership) throw Errors.forbidden('Select an organization first');
  return { user: auth.user, sessionId: auth.sessionId, ip: req.ip, ...auth.membership };
}

/** Injects the tenant RequestContext; rejects sessions without an active membership. */
export const Ctx = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => {
  return requireTenantContext(ctx.switchToHttp().getRequest<AuthedRequest>());
});

/** Injects the authenticated user (platform routes and account routes). */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthState => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw Errors.unauthorized();
  return req.auth;
});
