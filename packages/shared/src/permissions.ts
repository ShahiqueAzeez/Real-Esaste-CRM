import type { MembershipRole } from './enums';

/**
 * Permission catalogue. The backend enforces these with PermissionsGuard; the frontend only uses
 * them to decide which controls to show.
 */
export const PERMISSIONS = [
  'org:settings:manage',
  'org:integrations:manage',
  'users:read',
  'users:manage',
  'teams:manage',
  'leads:read:all',
  'leads:read:team',
  'leads:read:own',
  'leads:write',
  'leads:import',
  'leads:export',
  'leads:assign',
  'leads:delete',
  'queues:manage',
  'compliance:manage',
  'compliance:read',
  'calls:read:all',
  'calls:read:team',
  'calls:read:own',
  'calls:dial',
  'calls:recover',
  'recordings:play',
  'recordings:delete',
  'callbacks:read:all',
  'callbacks:read:team',
  'callbacks:read:own',
  'callbacks:manage',
  'monitor:view',
  'monitor:coach',
  'reports:read',
  'billing:read',
  'billing:manage',
  'whatsapp:send',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ADMIN: Permission[] = PERMISSIONS.filter((p) => p !== 'calls:dial' && p !== 'leads:read:own' && p !== 'calls:read:own' && p !== 'callbacks:read:own' && p !== 'leads:read:team' && p !== 'calls:read:team' && p !== 'callbacks:read:team');

const SUPERVISOR: Permission[] = [
  'users:read',
  'leads:read:team',
  'leads:write',
  'leads:assign',
  'compliance:read',
  'calls:read:team',
  'calls:recover',
  'recordings:play',
  'callbacks:read:team',
  'callbacks:manage',
  'monitor:view',
  'monitor:coach',
  'reports:read',
  'whatsapp:send',
];

const AGENT: Permission[] = ['leads:read:own', 'calls:read:own', 'calls:dial', 'callbacks:read:own', 'whatsapp:send'];

export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  ORG_ADMIN: ADMIN,
  SUPERVISOR,
  AGENT,
};

/** Permissions a tenant admin may grant to a supervisor on top of the role defaults. */
export const GRANTABLE_EXTRA_PERMISSIONS: Permission[] = ['billing:read', 'leads:export', 'leads:import', 'compliance:manage', 'audit:read', 'recordings:delete'];

export function permissionsFor(role: MembershipRole, extra: readonly string[] = []): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  if (role === 'SUPERVISOR') {
    for (const p of extra) {
      if ((GRANTABLE_EXTRA_PERMISSIONS as string[]).includes(p)) set.add(p as Permission);
    }
  }
  return set;
}

export function hasPermission(perms: ReadonlySet<string> | readonly string[], p: Permission): boolean {
  return Array.isArray(perms) ? perms.includes(p) : (perms as ReadonlySet<string>).has(p);
}

export type DataScope = 'all' | 'team' | 'own' | 'none';

/** Resolve the widest data scope a permission set grants for a resource family. */
export function scopeFor(perms: ReadonlySet<string>, family: 'leads' | 'calls' | 'callbacks'): DataScope {
  if (perms.has(`${family}:read:all`)) return 'all';
  if (perms.has(`${family}:read:team`)) return 'team';
  if (perms.has(`${family}:read:own`)) return 'own';
  return 'none';
}
