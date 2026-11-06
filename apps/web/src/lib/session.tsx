'use client';
import type { Permission } from '@crm/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, ApiError } from './api';
import type { Me } from './types';

export const meKey = ['auth', 'me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/** Client-side helper to hide controls. The API enforces every permission independently. */
export function usePermissions() {
  const { data } = useMe();
  const perms = React.useMemo(() => new Set(data?.membership?.permissions ?? []), [data]);
  return {
    me: data,
    role: data?.membership?.role ?? null,
    timezone: data?.membership?.tenant.timezone ?? 'Asia/Kolkata',
    can: (p: Permission) => perms.has(p),
  };
}

export function homePath(me: Me | null | undefined): string {
  if (!me) return '/login';
  if (!me.membership) return me.memberships.length > 0 ? '/select-org' : me.user.isPlatformAdmin ? '/platform' : '/login';
  switch (me.membership.role) {
    case 'AGENT':
      return '/agent';
    case 'SUPERVISOR':
      return '/supervisor';
    default:
      return '/dashboard';
  }
}

export function useSignOut() {
  const qc = useQueryClient();
  const router = useRouter();
  return async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  };
}
