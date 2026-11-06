'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { DayPoint } from '@/components/charts/calls-by-day';

export interface Overview {
  leads: { total: number; createdInRange: number; eligibleNow: number };
  calls: { initiated: number; attempted: number; answered: number; connected: number; answerRate: number | null; talkSeconds: number; averageTalkSeconds: number | null; simulated: number; agentUnreachable: number };
  outcomes: { code: string; label: string; category: string; count: number }[];
  conversions: number;
  agents: Record<string, number>;
  queues: { id: string; name: string; active: boolean; ready: number; scheduled: number; callbacks: number; inProgress: number; done: number; eligibleNow: number }[];
  callbacks: { scheduled: number; completed: number; completedOnTime: number; cancelled: number; overdue: number };
  costs: { voiceSeconds: number; providerReported: { currency: string | null; amount: number }[]; estimated: { currency: string | null; amount: number }[]; whatsappMessages: number; leadsImported: number; recordingSeconds: number; note: string };
}

export interface AgentRow {
  membershipId: string;
  name: string;
  active: boolean;
  attempted: number;
  connected: number;
  talkSeconds: number;
  averageTalkSeconds: number | null;
  positiveOutcomes: number;
  conversions: number;
  secondsByStatus: Record<string, number>;
  loggedInSeconds: number;
  callsPerHour: number | null;
}

type Q = { from: string; to: string; membershipId?: string; queueId?: string };

export function useOverview(q: Q) {
  return useQuery({ queryKey: ['reports', 'overview', q], queryFn: () => api.get<Overview>('/reports/overview', q), refetchInterval: 60_000 });
}
export function useCallsByDay(q: Q) {
  return useQuery({ queryKey: ['reports', 'by-day', q], queryFn: () => api.get<(DayPoint & { connected: number })[]>('/reports/calls-by-day', q) });
}
export function useAgentReport(q: Q) {
  return useQuery({ queryKey: ['reports', 'agents', q], queryFn: () => api.get<AgentRow[]>('/reports/agents', q) });
}

export function money(list: { currency: string | null; amount: number }[]): string {
  if (!list.length) return '—';
  return list.map((c) => (c.currency ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: c.currency, maximumFractionDigits: 2 }).format(c.amount) : c.amount.toFixed(2))).join(' + ');
}
