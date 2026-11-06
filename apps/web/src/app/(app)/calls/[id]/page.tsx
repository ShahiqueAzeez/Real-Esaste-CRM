'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { RecordingPlayer } from '@/components/recording-player';
import { CallStatusBadge, StatusBadge } from '@/components/status';
import { Badge, SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Field, Textarea } from '@/components/ui/form';
import { KeyValue, PageHeader } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatMoneyMicros, titleCase } from '@/lib/format';
import { usePermissions } from '@/lib/session';

interface CallDetail {
  id: string;
  status: string;
  isSimulated: boolean;
  provider: string;
  callingMode: string;
  fromNumber: string | null;
  toNumberE164: string;
  attemptNumber: number;
  countedAsAttempt: boolean;
  recordingEnabled: boolean;
  initiatedAt: string;
  agentAnsweredAt: string | null;
  customerAnsweredAt: string | null;
  endedAt: string | null;
  talkSeconds: number | null;
  billableSeconds: number | null;
  costMicros: number | null;
  costCurrency: string | null;
  costSource: string;
  failureReason: string | null;
  hangupCause: string | null;
  wrapUpStatus: string;
  lastEventAt: string | null;
  agent: { id: string; name: string | null };
  lead: { id: string; fullName: string; phone: string; status: string };
  outcome: { outcomeLabel: string; notes: string | null; recordedBy: string; callbackAt: string | null } | null;
  legs: { id: string; role: string; status: string; providerCallId?: string | null; initiatedAt: string | null; answeredAt: string | null; endedAt: string | null; billSeconds: number | null; costMicros: number | null; costCurrency: string | null; costSource: string; hangupCause: string | null; hangupSource: string | null; coachMode: boolean | null; supervisor: string | null }[];
  recordings: { id: string; status: string; durationSeconds: number | null; createdAt: string; retentionUntil: string | null }[];
}

export default function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, role, timezone } = usePermissions();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['call', id], queryFn: () => api.get<CallDetail>(`/calls/${id}`), refetchInterval: 10_000 });
  const events = useQuery({
    queryKey: ['call', id, 'events'],
    queryFn: () => api.get<{ id: string; type: string; source: string; signatureValid: boolean | null; occurredAt: string; receivedAt: string; processedAt: string | null; processingError: string | null }[]>(`/calls/${id}/events`),
    enabled: role !== 'AGENT',
  });
  const [recovering, setRecovering] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const recover = useMutation({
    mutationFn: () => api.post(`/calls/${id}/recover`, { notes }),
    onSuccess: () => {
      toast.success('Call closed by recovery');
      setRecovering(false);
      void qc.invalidateQueries({ queryKey: ['call', id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.error) return <Alert tone="bad">{errorMessage(q.error)}</Alert>;
  const c = q.data!;
  const terminal = ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'].includes(c.status);
  const needsRecovery = c.wrapUpStatus === 'PENDING' || !terminal;
  return (
    <div>
      <Link href="/calls" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Calls
      </Link>
      <PageHeader
        title={`Call with ${c.lead.fullName}`}
        badge={
          <div className="flex gap-1.5">
            <CallStatusBadge status={c.status} />
            {c.isSimulated && <SimulatedBadge />}
          </div>
        }
        description={`${formatDateTime(c.initiatedAt, timezone)} · ${c.agent.name ?? 'Agent'} · attempt ${c.attemptNumber}`}
        actions={
          can('calls:recover') && needsRecovery ? (
            <Button variant="outline" onClick={() => setRecovering(true)}>
              <LifeBuoy /> Recover call
            </Button>
          ) : undefined
        }
      />
      {c.isSimulated && <Alert tone="info" className="mb-4">This call was simulated. No real call was placed and no audio exists.</Alert>}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
              <KeyValue
                items={[
                  ['Lead', <Link key="l" href={`/leads/${c.lead.id}`} className="text-brand hover:underline">{c.lead.fullName}</Link>],
                  ['Number', <span key="n" className="font-mono">{c.toNumberE164}</span>],
                  ['Caller ID', c.fromNumber],
                  ['Provider', `${c.provider === 'MOCK' ? 'Simulator' : c.provider} · ${titleCase(c.callingMode)}`],
                  ['Counted as attempt', c.countedAsAttempt ? 'Yes' : 'No (customer not dialled)'],
                ]}
              />
              <KeyValue
                items={[
                  ['Agent answered', formatDateTime(c.agentAnsweredAt, timezone)],
                  ['Customer answered', formatDateTime(c.customerAnsweredAt, timezone)],
                  ['Ended', formatDateTime(c.endedAt, timezone)],
                  ['Talk time', formatDuration(c.talkSeconds)],
                  ['Billable', c.billableSeconds != null ? `${c.billableSeconds}s` : '—'],
                  ['Cost', c.costMicros != null ? `${formatMoneyMicros(c.costMicros, c.costCurrency)} (${c.costSource === 'PROVIDER' ? 'provider-reported' : 'estimate'})` : 'Not reported'],
                  ['Ended because', c.failureReason ? titleCase(c.failureReason) : c.hangupCause],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Call legs</CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-2">Leg</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Answered</th>
                    <th className="px-4 py-2">Ended</th>
                    <th className="px-4 py-2 text-right">Billed</th>
                    <th className="px-4 py-2 text-right">Cost</th>
                    <th className="px-4 py-2">Hangup</th>
                  </tr>
                </thead>
                <tbody>
                  {c.legs.map((l) => (
                    <tr key={l.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2 font-medium text-ink">
                        {titleCase(l.role)}
                        {l.supervisor && <span className="block text-xs font-normal text-muted">{l.supervisor} · {l.coachMode ? 'whisper' : 'barge'}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge value={l.status} />
                      </td>
                      <td className="px-4 py-2 text-xs">{formatDateTime(l.answeredAt, timezone)}</td>
                      <td className="px-4 py-2 text-xs">{formatDateTime(l.endedAt, timezone)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{l.billSeconds != null ? `${l.billSeconds}s` : '—'}</td>
                      <td className="px-4 py-2 text-right text-xs">{l.costMicros != null ? `${formatMoneyMicros(l.costMicros, l.costCurrency)}${l.costSource !== 'PROVIDER' ? ' est.' : ''}` : '—'}</td>
                      <td className="px-4 py-2 text-xs text-muted">{[l.hangupCause, l.hangupSource].filter(Boolean).join(' · ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {events.data && (
            <Card>
              <CardHeader>
                <CardTitle>Provider events</CardTitle>
              </CardHeader>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-line text-left uppercase tracking-wide text-muted">
                      <th className="px-4 py-2">Received</th>
                      <th className="px-4 py-2">Event</th>
                      <th className="px-4 py-2">Source</th>
                      <th className="px-4 py-2">Signature</th>
                      <th className="px-4 py-2">Processing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.data.map((e) => (
                      <tr key={e.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-1.5">{formatDateTime(e.receivedAt, timezone)}</td>
                        <td className="px-4 py-1.5 font-medium text-ink">{titleCase(e.type)}</td>
                        <td className="px-4 py-1.5">{e.source}</td>
                        <td className="px-4 py-1.5">{e.signatureValid == null ? 'n/a' : e.signatureValid ? <Badge tone="ok">Valid</Badge> : <Badge tone="bad">Invalid</Badge>}</td>
                        <td className="px-4 py-1.5">{e.processingError ? <span className="text-warn">{e.processingError}</span> : e.processedAt ? 'Applied' : 'Pending'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Outcome</CardTitle>
              <StatusBadge value={c.wrapUpStatus === 'DONE' || c.wrapUpStatus === 'RECOVERED' ? 'COMPLETED' : c.wrapUpStatus === 'PENDING' ? 'PENDING' : 'SKIPPED'} label={titleCase(c.wrapUpStatus)} />
            </CardHeader>
            <CardContent>
              {c.outcome ? (
                <KeyValue
                  items={[
                    ['Outcome', c.outcome.outcomeLabel],
                    ['Recorded by', titleCase(c.outcome.recordedBy)],
                    ['Callback', formatDateTime(c.outcome.callbackAt, timezone)],
                    ['Notes', c.outcome.notes],
                  ]}
                />
              ) : (
                <p className="text-sm text-muted">{c.wrapUpStatus === 'NOT_REQUIRED' ? 'No outcome needed: the customer was never dialled.' : 'Waiting for the agent’s wrap-up.'}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recording</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {c.recordings.length ? (
                c.recordings.map((r) =>
                  r.status === 'AVAILABLE' && can('recordings:play') ? (
                    <div key={r.id}>
                      <RecordingPlayer recordingId={r.id} durationSeconds={r.durationSeconds} />
                      <p className="mt-1 text-xs text-muted">Kept until {formatDateTime(r.retentionUntil, timezone)}. Access is logged.</p>
                    </div>
                  ) : (
                    <StatusBadge key={r.id} value={r.status} />
                  ),
                )
              ) : (
                <p className="text-sm text-muted">{c.recordingEnabled ? 'The provider has not delivered a recording for this call.' : 'Recording was not enabled for this call.'}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      <Dialog
        open={recovering}
        onOpenChange={setRecovering}
        title="Recover this call"
        description="Use when an agent cannot finish the wrap-up (browser closed, connection lost) or the provider stopped sending updates. Live legs are hung up and the call is closed with a supervisor outcome. This is logged."
        footer={
          <Button loading={recover.isPending} disabled={notes.trim().length < 5} onClick={() => recover.mutate()}>
            Close call
          </Button>
        }
      >
        <Field label="Reason" htmlFor="rec-notes" required>
          <Textarea id="rec-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Agent's browser crashed after the call ended" />
        </Field>
      </Dialog>
    </div>
  );
}
