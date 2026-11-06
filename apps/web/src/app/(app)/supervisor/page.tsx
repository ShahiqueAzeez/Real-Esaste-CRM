'use client';
import { RealtimeEvent, type ExpectIncomingPayload } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ear, Headphones, LogOut, Megaphone, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { toast } from 'sonner';
import { AgentStatusBadge, CallStatusBadge } from '@/components/status';
import { Badge, SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { PageHeader, StatCard } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { formatClock, formatDuration, formatNumber } from '@/lib/format';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime';
import { usePermissions } from '@/lib/session';
import { BrowserPhone, type PhoneState } from '@/lib/telephony/browser-phone';
import type { QueueSummary } from '@/lib/types';

interface Board {
  coaching: { available: boolean; reason: string | null };
  agents: { membershipId: string; name: string; team: string | null; status: string; pauseReason: string | null; statusChangedAt: string | null; currentCallId: string | null; last24h: { calls: number; talkSeconds: number } }[];
  activeCalls: { id: string; status: string; isSimulated: boolean; agentId: string; agent: string | null; lead: string; initiatedAt: string; customerAnsweredAt: string | null; monitoring: { supervisorId: string | null; coachMode: boolean | null }[] }[];
  queues: QueueSummary[];
  overdueCallbacks: number;
}

export default function SupervisorPage() {
  const { can, me } = usePermissions();
  const qc = useQueryClient();
  const { connected } = useRealtime();
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const board = useQuery({ queryKey: ['supervisor', 'board'], queryFn: () => api.get<Board>('/supervisor/board'), refetchInterval: connected ? 15_000 : 5_000 });
  const phoneRef = React.useRef<BrowserPhone | null>(null);
  const [phone, setPhone] = React.useState<{ state: PhoneState; message?: string }>({ state: 'idle' });
  const coachingAvailable = !!board.data?.coaching.available && can('monitor:coach');
  useRealtimeEvent<ExpectIncomingPayload>(RealtimeEvent.EXPECT_INCOMING, (p) => p.purpose === 'MONITOR' && phoneRef.current?.expect(p.callId, p.expiresAt));

  const connectAudio = async () => {
    if (phoneRef.current) return;
    const p = new BrowserPhone(
      (state, message) => setPhone({ state, message }),
      () => void qc.invalidateQueries({ queryKey: ['supervisor', 'board'] }),
    );
    phoneRef.current = p;
    await p.start(async () => (await api.post<{ token: string }>('/telephony/browser-token')).token);
  };
  React.useEffect(() => () => phoneRef.current?.stop(), []);

  const monitor = useMutation({
    mutationFn: ({ callId, mode }: { callId: string; mode: 'WHISPER' | 'BARGE' }) => api.post(`/supervisor/calls/${callId}/monitor`, { mode }),
    onSuccess: (_d, v) => toast.success(v.mode === 'WHISPER' ? 'Joining: only the agent will hear you' : 'Joining: agent and customer will hear you'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const switchMode = useMutation({
    mutationFn: ({ callId, mode }: { callId: string; mode: 'WHISPER' | 'BARGE' }) => api.post(`/supervisor/calls/${callId}/monitor/mode`, { mode }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const leave = useMutation({ mutationFn: (callId: string) => api.post(`/supervisor/calls/${callId}/monitor/stop`), onSuccess: () => phoneRef.current?.hangup(), onError: (e) => toast.error(errorMessage(e)) });

  if (board.isLoading) return <Skeleton className="h-96 w-full" />;
  if (board.error) return <Alert tone="bad">{errorMessage(board.error)}</Alert>;
  const b = board.data!;
  const counts = (s: string) => b.agents.filter((a) => a.status === s).length;
  return (
    <div>
      <PageHeader title="Live board" description={me?.membership?.role === 'SUPERVISOR' ? 'Agents in the teams you supervise.' : 'All agents in your organisation.'} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        <StatCard label="Ready" value={counts('READY')} />
        <StatCard label="On a call" value={counts('ON_CALL') + counts('DIALING')} />
        <StatCard label="Wrap-up" value={counts('WRAP_UP')} />
        <StatCard label="Paused" value={counts('PAUSED')} />
        <StatCard label="Offline" value={counts('OFFLINE')} />
        <StatCard label="Overdue callbacks" value={b.overdueCallbacks} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Active calls</CardTitle>
              <CardDescription>{b.coaching.available ? 'Whisper: only the agent hears you. Barge: everyone hears you. All monitoring is logged.' : (b.coaching.reason ?? 'Coaching unavailable')}</CardDescription>
            </div>
            {coachingAvailable && (
              <Button size="sm" variant="outline" onClick={connectAudio} disabled={phone.state === 'registered' || phone.state === 'registering'}>
                <Headphones /> {phone.state === 'registered' ? 'Audio connected' : phone.state === 'registering' || phone.state === 'loading' ? 'Connecting…' : 'Connect my audio'}
              </Button>
            )}
          </CardHeader>
          {phone.message && <Alert tone="bad" className="mx-5 mt-3">{phone.message}</Alert>}
          <CardContent className="p-0">
            {b.activeCalls.length ? (
              <ul className="divide-y divide-line">
                {b.activeCalls.map((c) => {
                  const mine = c.monitoring.find((m) => m.supervisorId === me?.membership?.id);
                  const talk = c.customerAnsweredAt ? Math.round((now - Date.parse(c.customerAnsweredAt)) / 1000) : null;
                  return (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-ink">{c.agent}</span>
                          <span className="text-muted">→</span>
                          <Link href={`/calls/${c.id}`} className="text-ink hover:underline">
                            {c.lead}
                          </Link>
                          {c.isSimulated && <SimulatedBadge />}
                          {c.monitoring.length > 0 && <Badge tone="brand">Monitored</Badge>}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                          <CallStatusBadge status={c.status} />
                          <span className="tabular-nums">{talk != null ? `talk ${formatClock(talk)}` : `started ${formatClock(Math.round((now - Date.parse(c.initiatedAt)) / 1000))} ago`}</span>
                        </div>
                      </div>
                      {can('monitor:coach') && (
                        <div className="flex gap-2">
                          {mine ? (
                            <>
                              <Button size="sm" variant="outline" onClick={() => switchMode.mutate({ callId: c.id, mode: mine.coachMode ? 'BARGE' : 'WHISPER' })}>
                                {mine.coachMode ? <Megaphone /> : <Ear />} Switch to {mine.coachMode ? 'barge' : 'whisper'}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => leave.mutate(c.id)}>
                                <LogOut /> Leave
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" variant="outline" disabled={!coachingAvailable || c.status !== 'CONNECTED' || phone.state !== 'registered'} title={!coachingAvailable ? (b.coaching.reason ?? undefined) : phone.state !== 'registered' ? 'Connect your audio first' : undefined} onClick={() => monitor.mutate({ callId: c.id, mode: 'WHISPER' })}>
                                <Ear /> Whisper
                              </Button>
                              <Button size="sm" variant="ghost" disabled={!coachingAvailable || c.status !== 'CONNECTED' || phone.state !== 'registered'} onClick={() => monitor.mutate({ callId: c.id, mode: 'BARGE' })}>
                                <Megaphone /> Barge
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon={PhoneCall} title="No calls in progress" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Queues</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {b.queues.map((q) => (
              <div key={q.id}>
                <p className="font-medium text-ink">{q.name}</p>
                <p className="text-xs text-muted">
                  {formatNumber(q.counts.eligibleNow)} eligible · {formatNumber(q.counts.callbacks)} callbacks · {formatNumber(q.counts.scheduled)} scheduled
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Agents</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2">Agent</th>
                  <th className="px-4 py-2">Team</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">For</th>
                  <th className="px-4 py-2 text-right">Calls (24h)</th>
                  <th className="px-4 py-2 text-right">Talk (24h)</th>
                </tr>
              </thead>
              <tbody>
                {b.agents.map((a) => (
                  <tr key={a.membershipId} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 font-medium text-ink">{a.name}</td>
                    <td className="px-4 py-2 text-muted">{a.team ?? '—'}</td>
                    <td className="px-4 py-2">
                      <AgentStatusBadge status={a.status} /> {a.pauseReason && <span className="ml-1 text-xs text-muted">{a.pauseReason}</span>}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-muted">{a.statusChangedAt ? formatClock(Math.round((now - Date.parse(a.statusChangedAt)) / 1000)) : '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{a.last24h.calls}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatDuration(a.last24h.talkSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
