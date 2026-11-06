'use client';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { api } from './api';
import { usePermissions } from './session';
import type { Member, QueueSummary } from './types';

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Members are visible to admins and supervisors (users:read). */
export function useMembers() {
  const { can } = usePermissions();
  return useQuery({ queryKey: ['members'], queryFn: () => api.get<Member[]>('/members'), enabled: can('users:read'), staleTime: 60_000 });
}

export function useAgents() {
  const q = useMembers();
  return (q.data ?? []).filter((m) => m.role === 'AGENT' && m.status === 'ACTIVE');
}

export function useQueues() {
  return useQuery({ queryKey: ['queues'], queryFn: () => api.get<QueueSummary[]>('/queues'), staleTime: 30_000 });
}
