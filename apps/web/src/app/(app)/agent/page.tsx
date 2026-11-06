'use client';
import { RealtimeEvent, type CallUpdatedPayload, type ExpectIncomingPayload } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, Headset, Mic, MicOff, Pause, Phone, PhoneOff, Play, Power, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { toast } from 'sonner';
import { AgentStatusBadge, CallStatusBadge, StatusBadge } from '@/components/status';
import { SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { KeyValue, PageHeader, StatCard } from '@/components/ui/page';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatBudgetRange, formatClock, formatDateTime, formatDuration, formatTime, titleCase, toLocalInput } from '@/lib/format';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime';
import { usePermissions } from '@/lib/session';
import { BrowserPhone, type PhoneState } from '@/lib/telephony/browser-phone';
import { checkAudioDevices, type DeviceReport } from '@/lib/telephony/device-check';
import type { AgentStateResponse, CallView, OutcomeDefinition, Page } from '@/lib/types';
import { cn } from '@/lib/utils';

const TERMINAL = ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'];

function useNow(intervalMs = 1000) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const STEPS: { key: string; label: string; reached: (c: CallView) => boolean }[] = [
  { key: 'agent', label: 'Your line', reached: (c) => !!c.agentAnsweredAt },
  { key: 'ringing', label: 'Ringing customer', reached: (c) => ['CUSTOMER_RINGING', 'CONNECTED'].includes(c.status) || !!c.customerAnsweredAt },
  { key: 'connected', label: 'Connected', reached: (c) => !!c.customerAnsweredAt },
];

const FAILURE_TEXT: Record<string, string> = {
  agent_unreachable: 'Your line did not answer, so the customer was not called.',
  provider_error: 'The telephony provider rejected the call. An administrator should check Integrations.',
  customer_leg_failed: 'The call to the customer failed (network or number problem).',
  compliance_block: 'The lead became ineligible (suppressed or consent withdrawn) and was not called.',
  agent_hung_up_before_answer: 'You ended the call before the customer answered.',
  cancelled_before_dial: 'The call ended before the customer was dialled.',
};

export default function AgentConsolePage() {
  const qc = useQueryClient();
  const { timezone } = usePermissions();
  const { connected, emit } = useRealtime();
  const now = useNow();
  const [autoContinue, setAutoContinue] = React.useState(true);
  const [dialError, setDialError] = React.useState<{ code: string; message: string; nextAt?: string | null } | null>(null);
  const [noLeadsUntil, setNoLeadsUntil] = React.useState<{ at: number; nextAvailableAt: string | null } | null>(null);
  const [device, setDevice] = React.useState<DeviceReport | null>(null);
  const [phoneState, setPhoneState] = React.useState<{ state: PhoneState; message?: string }>({ state: 'idle' });
  const [muted, setMuted] = React.useState(false);
  const phoneRef = React.useRef<BrowserPhone | null>(null);

  const stateQ = useQuery({ queryKey: ['agent', 'state'], queryFn: () => api.get<AgentStateResponse>('/agent/state'), refetchInterval: connected ? 15_000 : 3_000 });
  const outcomesQ = useQuery({ queryKey: ['org', 'outcomes'], queryFn: () => api.get<OutcomeDefinition[]>('/org/outcomes'), staleTime: 300_000 });
  const todayQ = useQuery({ queryKey: ['agent', 'today'], queryFn: () => api.get<{ attempted: number; connected: number; talkSeconds: number; outcomes: { label: string; count: number }[]; callbacksDueSoon: number }>('/agent/today'), refetchInterval: 60_000 });
  const callbacksQ = useQuery({ queryKey: ['callbacks', 'mine'], queryFn: () => api.get<Page<{ id: string; dueAt: string; overdue: boolean; notes: string | null; lead: { id: string; fullName: string } }>>('/callbacks', { status: 'PENDING', pageSize: 6 }), refetchInterval: 60_000 });

  const data = stateQ.data;
  const status = data?.state?.status ?? 'OFFLINE';
  const call = data?.currentCall ?? null;
  const telephony = data?.telephony;
  const realBrowser = !!telephony && !telephony.simulated && data?.callingMode === 'BROWSER';
  const refresh = React.useCallback(() => qc.invalidateQueries({ queryKey: ['agent'] }), [qc]);

  useRealtimeEvent<CallUpdatedPayload>(RealtimeEvent.CALL_UPDATED, () => refresh());
  useRealtimeEvent(RealtimeEvent.AGENT_STATE, () => refresh());
  useRealtimeEvent<ExpectIncomingPayload>(RealtimeEvent.EXPECT_INCOMING, (p) => phoneRef.current?.expect(p.callId, p.expiresAt));

  // Heartbeat keeps the agent "present"; the server moves silent agents Offline after 90 s.
  React.useEffect(() => {
    const beat = () => (connected ? emit('agent.heartbeat') : api.post('/agent/heartbeat').catch(() => undefined));
    beat();
    const t = setInterval(beat, 20_000);
    return () => clearInterval(t);
  }, [connected, emit]);

  const reportDevice = React.useCallback(async (report: DeviceReport, registered: boolean) => {
    await api.post('/agent/device', { microphone: report.microphone, providerRegistered: registered, inputDeviceLabel: report.inputDeviceLabel, outputDeviceLabel: report.outputDeviceLabel }).catch(() => undefined);
  }, []);

  const runDeviceCheck = React.useCallback(async () => {
    const report = await checkAudioDevices();
    setDevice(report);
    await reportDevice(report, phoneRef.current?.state === 'registered');
    if (report.microphone !== 'granted') toast.error(report.error ?? 'Microphone not available');
    return report;
  }, [reportDevice]);

  // Run silently when permission was already granted earlier.
  React.useEffect(() => {
    let cancelled = false;
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => {
        if (!cancelled && p.state === 'granted') void runDeviceCheck();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runDeviceCheck]);

  // Register the browser with Plivo (receive-only) when this agent uses browser calling.
  React.useEffect(() => {
    if (!realBrowser || device?.microphone !== 'granted' || phoneRef.current) return;
    const phone = new BrowserPhone(
      (state, message) => {
        setPhoneState({ state, message });
        if (state === 'registered' || state === 'failed') void reportDevice(device, state === 'registered');
      },
      (cs, detail) => {
        if (cs === 'rejected') toast.warning(detail ?? 'Rejected an unexpected call');
        if (cs === 'failed') toast.error(`Browser call failed${detail ? `: ${detail}` : ''}`);
        if (cs === 'ended') setMuted(false);
        refresh();
      },
    );
    phoneRef.current = phone;
    void phone.start(async () => (await api.post<{ token: string }>('/telephony/browser-token')).token);
    return () => {
      phone.stop();
      phoneRef.current = null;
    };
  }, [realBrowser, device, reportDevice, refresh]);

  const setStatus = useMutation({
    mutationFn: (body: { status: 'READY' | 'PAUSED' | 'OFFLINE'; reason?: string }) => api.post('/agent/status', body),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const dialNext = useMutation({
    mutationFn: () => api.post<{ result: 'DIALING' | 'EXISTING' | 'NO_LEADS'; call?: CallView; nextAvailableAt?: string | null }>('/agent/dial-next', {}, { 'Idempotency-Key': crypto.randomUUID() }),
    onSuccess: (res) => {
      setDialError(null);
      if (res.result === 'NO_LEADS') setNoLeadsUntil({ at: Date.now() + 20_000, nextAvailableAt: res.nextAvailableAt ?? null });
      else setNoLeadsUntil(null);
      refresh();
    },
    onError: (err) => {
      const e = err instanceof ApiError ? err : null;
      setDialError({ code: e?.code ?? 'ERROR', message: errorMessage(err), nextAt: (e?.details as { nextWindowAt?: string } | undefined)?.nextWindowAt });
      setAutoContinue(false);
      refresh();
    },
  });

  const startCalling = async () => {
    setDialError(null);
    if (data?.callingMode === 'BROWSER' && device?.microphone !== 'granted') {
      const report = await runDeviceCheck();
      if (report.microphone !== 'granted' && !telephony?.simulated) return;
    } else if (!data?.state?.deviceCheckedAt) {
      await runDeviceCheck();
    }
    if (status !== 'READY') await setStatus.mutateAsync({ status: 'READY' });
    setAutoContinue(true);
    dialNext.mutate();
  };

  // Progressive auto-advance: when Ready and idle, fetch the next lead (backs off when the queue is empty).
  React.useEffect(() => {
    if (!autoContinue || status !== 'READY' || call || dialNext.isPending || dialError) return;
    if (noLeadsUntil && Date.now() < noLeadsUntil.at) return;
    const t = setTimeout(() => dialNext.mutate(), 1500);
    return () => clearTimeout(t);
  }, [autoContinue, status, call, dialNext, dialError, noLeadsUntil, now]);

  const hangup = useMutation({
    mutationFn: (id: string) => api.post(`/calls/${id}/hangup`),
    onMutate: () => phoneRef.current?.hangup(),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const simulate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post(`/calls/${id}/simulate`, { action }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (stateQ.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (stateQ.error) return <Alert tone="bad" title="Could not load your console">{errorMessage(stateQ.error)}</Alert>;

  const inCall = !!call && !TERMINAL.includes(call.status);
  const needsWrapUp = !!call && TERMINAL.includes(call.status) && call.wrapUpStatus === 'PENDING';
  const statusSince = data?.state?.statusChangedAt ? Math.round((now - Date.parse(data.state.statusChangedAt)) / 1000) : null;

  return (
    <div>
      <PageHeader
        title="Calling console"
        badge={telephony?.simulated ? <SimulatedBadge /> : undefined}
        description={telephony?.simulated ? 'Simulated mode: no real calls are placed and no audio is carried.' : data?.callingMode === 'PHONE' ? 'Phone mode: your phone rings first, then the customer is dialled.' : 'Browser calling: your browser rings first, then the customer is dialled.'}
        actions={
          <div className="flex items-center gap-2">
            <AgentStatusBadge status={status} />
            {statusSince != null && <span className="text-xs tabular-nums text-muted">{formatClock(statusSince)}</span>}
          </div>
        }
      />

      <ReadinessBar
        telephony={telephony}
        callingMode={data?.callingMode}
        agentPhoneConfigured={!!data?.agentPhoneConfigured}
        device={device}
        phone={phoneState}
        realtime={connected}
        onCheck={runDeviceCheck}
      />

      {dialError && (
        <Alert
          tone={dialError.code === 'OUTSIDE_CALLING_HOURS' ? 'warn' : 'bad'}
          className="mb-4"
          title={dialError.code === 'OUTSIDE_CALLING_HOURS' ? 'Outside calling hours' : 'Could not start the next call'}
          action={
            <Button size="sm" variant="outline" onClick={() => setDialError(null)}>
              Dismiss
            </Button>
          }
        >
          {dialError.message}
          {dialError.nextAt && <> Next window opens {formatDateTime(dialError.nextAt, timezone)}.</>}
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{call ? 'Current call' : 'Next call'}</CardTitle>
                <CardDescription>{call ? `Attempt ${call.attemptNumber} · started ${formatTime(call.initiatedAt, timezone)}` : 'Leads are assigned one at a time, after you choose Start calling.'}</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!inCall && !needsWrapUp && status !== 'READY' && (
                  <Button onClick={startCalling} loading={setStatus.isPending || dialNext.isPending}>
                    <Play /> Start calling
                  </Button>
                )}
                {!inCall && !needsWrapUp && status === 'READY' && (
                  <>
                    <Button onClick={() => dialNext.mutate()} loading={dialNext.isPending}>
                      <Phone /> Call next lead
                    </Button>
                    <Button variant="outline" onClick={() => setStatus.mutate({ status: 'PAUSED', reason: 'Break' })}>
                      <Pause /> Pause
                    </Button>
                  </>
                )}
                {!inCall && !needsWrapUp && status !== 'OFFLINE' && (
                  <Button variant="ghost" onClick={() => setStatus.mutate({ status: 'OFFLINE' })}>
                    <Power /> Go offline
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {call ? (
                <CallPanel
                  call={call}
                  now={now}
                  timezone={timezone}
                  realBrowser={realBrowser}
                  muted={muted}
                  onMute={() => {
                    phoneRef.current?.setMuted(!muted);
                    setMuted(!muted);
                  }}
                  onHangup={() => hangup.mutate(call.id)}
                  hangingUp={hangup.isPending}
                  onSimulate={(action) => simulate.mutate({ id: call.id, action })}
                  simulated={!!telephony?.simulated}
                />
              ) : status === 'READY' ? (
                <EmptyState
                  icon={Headset}
                  title={dialNext.isPending ? 'Finding your next lead…' : 'Waiting for an eligible lead'}
                  description={
                    noLeadsUntil?.nextAvailableAt
                      ? `No lead is due right now. The next one becomes available ${formatDateTime(noLeadsUntil.nextAvailableAt, timezone)}. We will keep checking.`
                      : noLeadsUntil
                        ? 'No eligible leads right now. We will keep checking every 20 seconds.'
                        : 'Only leads with recorded consent, inside calling hours and not on the do-not-call list are offered.'
                  }
                />
              ) : (
                <EmptyState icon={Headset} title={status === 'PAUSED' ? 'You are paused' : 'You are offline'} description={data?.state?.pauseReason ?? 'Choose Start calling when you are ready to take leads.'} />
              )}
            </CardContent>
          </Card>

          {needsWrapUp && call && (
            <WrapUpForm
              call={call}
              outcomes={outcomesQ.data ?? []}
              onSaved={(next) => {
                refresh();
                void qc.invalidateQueries({ queryKey: ['callbacks'] });
                if (next === 'READY') setAutoContinue(true);
              }}
            />
          )}

          {call && <LeadHistory leadId={call.lead.id} timezone={timezone} />}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Today</CardTitle>
              <Checkbox label="Auto-dial next lead" checked={autoContinue} onChange={(e) => setAutoContinue(e.target.checked)} />
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2">
              <StatCard label="Attempts" value={todayQ.data?.attempted ?? '—'} className="px-3" />
              <StatCard label="Connected" value={todayQ.data?.connected ?? '—'} className="px-3" />
              <StatCard label="Talk time" value={formatDuration(todayQ.data?.talkSeconds ?? 0)} className="px-3" />
              {todayQ.data?.outcomes.length ? (
                <ul className="col-span-3 mt-1 space-y-1 text-sm">
                  {todayQ.data.outcomes.map((o) => (
                    <li key={o.label} className="flex justify-between text-ink-2">
                      <span>{o.label}</span>
                      <span className="tabular-nums">{o.count}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>My callbacks</CardTitle>
              <Link href="/callbacks" className="text-xs text-brand hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent>
              {callbacksQ.data?.items.length ? (
                <ul className="space-y-2">
                  {callbacksQ.data.items.map((cb) => (
                    <li key={cb.id} className="flex items-start gap-2 text-sm">
                      <CalendarClock className={cn('mt-0.5 size-4', cb.overdue ? 'text-bad' : 'text-muted')} />
                      <div className="min-w-0">
                        <Link href={`/leads/${cb.lead.id}`} className="font-medium text-ink hover:underline">
                          {cb.lead.fullName}
                        </Link>
                        <p className={cn('text-xs', cb.overdue ? 'text-bad' : 'text-muted')}>
                          {cb.overdue ? 'Overdue · ' : ''}
                          {formatDateTime(cb.dueAt, timezone)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No pending callbacks. Due callbacks are offered to you first.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Chip({ ok, warn, icon: Icon, children }: { ok?: boolean; warn?: boolean; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', ok ? 'border-ok/25 bg-ok-soft text-ok' : warn ? 'border-warn/25 bg-warn-soft text-warn' : 'border-bad/25 bg-bad-soft text-bad')}>
      <Icon className="size-3.5" />
      {children}
    </span>
  );
}

function ReadinessBar({ telephony, callingMode, agentPhoneConfigured, device, phone, realtime, onCheck }: {
  telephony: AgentStateResponse['telephony'] | undefined;
  callingMode: 'BROWSER' | 'PHONE' | undefined;
  agentPhoneConfigured: boolean;
  device: DeviceReport | null;
  phone: { state: PhoneState; message?: string };
  realtime: boolean;
  onCheck: () => void;
}) {
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const browserMode = callingMode === 'BROWSER';
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {browserMode && (
          <Chip ok={device?.microphone === 'granted'} warn={!device} icon={device?.microphone === 'granted' ? Mic : MicOff}>
            {device?.microphone === 'granted' ? `Microphone OK${device.inputDeviceLabel ? ` · ${device.inputDeviceLabel.slice(0, 32)}` : ''}` : device ? 'Microphone unavailable' : 'Microphone not checked'}
          </Chip>
        )}
        {!telephony?.configured ? (
          <Chip icon={PhoneOff}>Calling not configured</Chip>
        ) : telephony.simulated ? (
          <Chip ok icon={CheckCircle2}>
            Simulated provider
          </Chip>
        ) : browserMode ? (
          <Chip ok={phone.state === 'registered'} warn={['loading', 'registering', 'idle'].includes(phone.state)} icon={Phone}>
            {phone.state === 'registered' ? 'Calling service connected' : phone.state === 'failed' || phone.state === 'unsupported' ? 'Calling service error' : 'Connecting calling service…'}
          </Chip>
        ) : (
          <Chip ok={agentPhoneConfigured} icon={Phone}>
            {agentPhoneConfigured ? 'Your phone will ring first' : 'No agent phone number set'}
          </Chip>
        )}
        <Chip ok={realtime && online} warn={!realtime && online} icon={realtime && online ? Wifi : WifiOff}>
          {!online ? 'Offline' : realtime ? 'Live updates on' : 'Live updates reconnecting (polling)'}
        </Chip>
        {browserMode && (
          <Button size="sm" variant="ghost" onClick={onCheck}>
            <RefreshCw /> Check audio devices
          </Button>
        )}
      </div>
      {(phone.state === 'failed' || phone.state === 'unsupported') && phone.message && <Alert tone="bad">{phone.message}</Alert>}
      {telephony && !telephony.configured && <Alert tone="warn" title="Calling is not set up">An administrator needs to add Plivo credentials in Integrations before calls can be placed.</Alert>}
    </div>
  );
}

function CallPanel({ call, now, timezone, realBrowser, muted, onMute, onHangup, hangingUp, onSimulate, simulated }: {
  call: CallView;
  now: number;
  timezone: string;
  realBrowser: boolean;
  muted: boolean;
  onMute: () => void;
  onHangup: () => void;
  hangingUp: boolean;
  onSimulate: (action: string) => void;
  simulated: boolean;
}) {
  const active = !TERMINAL.includes(call.status);
  const talk = call.customerAnsweredAt ? Math.round(((call.endedAt ? Date.parse(call.endedAt) : now) - Date.parse(call.customerAnsweredAt)) / 1000) : null;
  const elapsed = Math.round(((call.endedAt ? Date.parse(call.endedAt) : now) - Date.parse(call.initiatedAt)) / 1000);
  const l = call.lead;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">{l.fullName}</h2>
            {call.isSimulated && <SimulatedBadge />}
          </div>
          <p className="mt-0.5 font-mono text-sm text-ink-2">{l.phone}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge value={l.status} />
            <StatusBadge value={l.priority} />
            <StatusBadge value={l.consentStatus} label={`Consent: ${titleCase(l.consentStatus)}`} />
          </div>
        </div>
        <div className="text-right">
          <CallStatusBadge status={call.status} />
          <p className={cn('mt-2 text-3xl font-semibold tabular-nums', call.status === 'CONNECTED' ? 'text-ok' : 'text-ink')} aria-live="polite">
            {formatClock(talk ?? elapsed)}
          </p>
          <p className="text-xs text-muted">{talk != null ? 'talk time' : 'since call started'}</p>
        </div>
      </div>

      <ol className="grid grid-cols-3 gap-2" aria-label="Call progress">
        {STEPS.map((s) => {
          const reached = s.reached(call);
          const current = active && !reached && STEPS.find((x) => !x.reached(call))?.key === s.key;
          return (
            <li key={s.key} className={cn('rounded-lg border px-3 py-2 text-xs', reached ? 'border-ok/30 bg-ok-soft text-ok' : current ? 'animate-pulse-ring border-brand/40 bg-brand-soft text-brand' : 'border-line text-muted')}>
              {s.label}
            </li>
          );
        })}
      </ol>

      {!active && call.failureReason && <Alert tone="warn">{FAILURE_TEXT[call.failureReason] ?? titleCase(call.failureReason)}</Alert>}
      {!active && call.hangupCause && !call.failureReason && <p className="text-xs text-muted">Ended: {call.hangupCause}</p>}

      <KeyValue
        items={[
          ['Interest', l.propertyInterest],
          ['Location', l.preferredLocation],
          ['Budget', formatBudgetRange(l.budgetMin, l.budgetMax)],
          ['Source', l.source],
          ['Attempts (incl. this call)', l.attemptCount],
          ['Last outcome', l.lastCallOutcome ? titleCase(l.lastCallOutcome) : null],
        ]}
      />

      {active && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button variant="danger" size="lg" onClick={onHangup} loading={hangingUp}>
            <PhoneOff /> Hang up
          </Button>
          {realBrowser && (
            <Button variant="outline" size="lg" onClick={onMute} aria-pressed={muted}>
              {muted ? <MicOff /> : <Mic />} {muted ? 'Unmute' : 'Mute'}
            </Button>
          )}
          {call.recordingEnabled && <span className="text-xs text-muted">This call is being recorded.</span>}
        </div>
      )}

      {active && simulated && call.isSimulated && (
        <div className="rounded-lg border border-dashed border-sim/40 bg-sim-soft/50 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-sim">Simulation controls (no real call)</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onSimulate('answer')} disabled={!!call.customerAnsweredAt}>
              Customer answers
            </Button>
            <Button size="sm" variant="outline" onClick={() => onSimulate('busy')} disabled={!!call.customerAnsweredAt}>
              Busy
            </Button>
            <Button size="sm" variant="outline" onClick={() => onSimulate('no-answer')} disabled={!!call.customerAnsweredAt}>
              No answer
            </Button>
            <Button size="sm" variant="outline" onClick={() => onSimulate('customer-hangup')} disabled={!call.customerAnsweredAt}>
              Customer hangs up
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted">Started {formatDateTime(call.initiatedAt, timezone)}</p>
    </div>
  );
}

function WrapUpForm({ call, outcomes, onSaved }: { call: CallView; outcomes: OutcomeDefinition[]; onSaved: (next: 'READY' | 'PAUSED') => void }) {
  const selectable = outcomes.filter((o) => o.active && o.selectable);
  const [code, setCode] = React.useState<string>(call.suggestedOutcome ?? '');
  const [notes, setNotes] = React.useState('');
  const [callbackAt, setCallbackAt] = React.useState(() => toLocalInput(new Date(Date.now() + 24 * 3600_000)));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const def = selectable.find((o) => o.code === code);
  const needsCallback = !!def && (def.requiresCallback || def.retryBehavior === 'CALLBACK');
  const save = useMutation({
    mutationFn: (next: 'READY' | 'PAUSED') =>
      api.post(`/calls/${call.id}/outcome`, { outcomeCode: code, notes: notes.trim() || null, callbackAt: needsCallback ? new Date(callbackAt).toISOString() : null, next }),
    onSuccess: (_d, next) => {
      toast.success('Outcome saved');
      onSaved(next);
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });
  const submit = (next: 'READY' | 'PAUSED') => {
    const e: Record<string, string> = {};
    if (!def) e.outcomeCode = 'Choose an outcome';
    if (def?.requiresNotes && !notes.trim()) e.notes = `Notes are required for “${def.label}”`;
    if (needsCallback && (!callbackAt || new Date(callbackAt).getTime() < Date.now() + 60_000)) e.callbackAt = 'Choose a future time';
    setErrors(e);
    if (Object.keys(e).length === 0) save.mutate(next);
  };
  return (
    <Card className="border-warn/40">
      <CardHeader>
        <div>
          <CardTitle>Wrap-up required</CardTitle>
          <CardDescription>Save the outcome before taking the next call.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">Outcome</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {selectable.map((o) => (
              <label key={o.code} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm', code === o.code ? 'border-brand bg-brand-soft text-brand' : 'border-line hover:bg-subtle')}>
                <input type="radio" name="outcome" value={o.code} checked={code === o.code} onChange={() => setCode(o.code)} className="accent-[var(--color-brand)]" />
                {o.label}
              </label>
            ))}
          </div>
          {errors.outcomeCode && <p className="mt-1 text-xs text-bad">{errors.outcomeCode}</p>}
        </fieldset>
        {needsCallback && (
          <Field label="Callback time" htmlFor="cb" required error={errors.callbackAt} hint="Shown in your local time. The lead returns to you at this time.">
            <Input id="cb" type="datetime-local" value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} />
          </Field>
        )}
        <Field label="Notes" htmlFor="notes" required={def?.requiresNotes} error={errors.notes}>
          <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What did the customer say? Next steps?" maxLength={4000} />
        </Field>
        {def?.suppressReason && <Alert tone="warn">This adds the number to the do-not-call list. It will not be called or messaged again.</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => submit('READY')} loading={save.isPending && save.variables === 'READY'}>
            Save & continue
          </Button>
          <Button variant="outline" onClick={() => submit('PAUSED')} loading={save.isPending && save.variables === 'PAUSED'}>
            Save & pause
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LeadHistory({ leadId, timezone }: { leadId: string; timezone: string }) {
  const q = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () =>
      api.get<{
        notes: { id: string; body: string; author: string | null; createdAt: string }[];
        calls: { id: string; status: string; initiatedAt: string; talkSeconds: number | null; agent: string | null; outcome: { label: string; notes: string | null } | null; isSimulated: boolean }[];
      }>(`/leads/${leadId}`),
  });
  if (!q.data) return null;
  const past = q.data.calls.slice(0, 6);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead history</CardTitle>
        <Link href={`/leads/${leadId}`} className="text-xs text-brand hover:underline">
          Open lead
        </Link>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Calls</p>
          <ul className="space-y-2 text-sm">
            {past.map((c) => (
              <li key={c.id}>
                <div className="flex items-center gap-2">
                  <CallStatusBadge status={c.status} />
                  {c.isSimulated && <SimulatedBadge />}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {formatDateTime(c.initiatedAt, timezone)} · {c.agent ?? '—'} · {formatDuration(c.talkSeconds)}
                </p>
                {c.outcome && (
                  <p className="text-xs text-ink-2">
                    {c.outcome.label}
                    {c.outcome.notes ? ` — ${c.outcome.notes}` : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Notes</p>
          {q.data.notes.length ? (
            <ul className="space-y-2 text-sm">
              {q.data.notes.slice(0, 6).map((n) => (
                <li key={n.id}>
                  <p className="whitespace-pre-wrap text-ink-2">{n.body}</p>
                  <p className="text-xs text-muted">
                    {n.author ?? 'System'} · {formatDateTime(n.createdAt, timezone)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No notes yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
