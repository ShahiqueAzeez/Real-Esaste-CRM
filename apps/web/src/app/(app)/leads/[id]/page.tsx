'use client';
import { CONSENT_STATUSES, LEAD_PRIORITIES, LEAD_STATUSES } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarPlus, MessageCircle, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { RecordingPlayer } from '@/components/recording-player';
import { CallStatusBadge, StatusBadge } from '@/components/status';
import { SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { KeyValue, PageHeader } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { formatBudgetRange, formatDateTime, formatDuration, titleCase, toLocalInput } from '@/lib/format';
import { usePermissions } from '@/lib/session';
import type { Lead, Page } from '@/lib/types';

interface LeadDetail {
  lead: Lead & { consentEvidence?: string | null };
  queueItem: { state: string; availableAt: string; attempts: number; isCallback: boolean; doneReason: string | null; queue: { id: string; name: string } } | null;
  notes: { id: string; body: string; author: string | null; createdAt: string; callId: string | null }[];
  calls: { id: string; status: string; isSimulated: boolean; initiatedAt: string; talkSeconds: number | null; agent: string | null; outcome: { code: string; label: string; notes: string | null } | null; recordings: { id: string; durationSeconds: number | null }[] }[];
  callbacks: { id: string; dueAt: string; status: string; notes: string | null }[];
}

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, timezone } = usePermissions();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => api.get<LeadDetail>(`/leads/${id}`) });
  const activity = useQuery({ queryKey: ['lead', id, 'activity'], queryFn: () => api.get<Page<{ id: string; type: string; data: Record<string, unknown> | null; createdAt: string }>>(`/leads/${id}/activity`, { pageSize: 30 }) });
  const [dialog, setDialog] = React.useState<'edit' | 'consent' | 'callback' | 'whatsapp' | 'delete' | null>(null);
  const [note, setNote] = React.useState('');
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['lead', id] });
    void qc.invalidateQueries({ queryKey: ['leads'] });
  };
  const addNote = useMutation({
    mutationFn: () => api.post(`/leads/${id}/notes`, { body: note }),
    onSuccess: () => {
      setNote('');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/leads/${id}`),
    onSuccess: () => {
      toast.success('Lead deleted');
      void qc.invalidateQueries({ queryKey: ['leads'] });
      router.replace('/leads');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.error) return <Alert tone="bad" title="Lead unavailable">{errorMessage(q.error)}</Alert>;
  const { lead, queueItem, notes, calls, callbacks } = q.data!;

  return (
    <div>
      <Link href="/leads" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Leads
      </Link>
      <PageHeader
        title={lead.fullName}
        description={<span className="font-mono">{lead.phoneE164}</span>}
        badge={
          <div className="flex gap-1.5">
            <StatusBadge value={lead.status} />
            <StatusBadge value={lead.priority} />
          </div>
        }
        actions={
          <>
            {can('leads:write') && (
              <Button variant="outline" onClick={() => setDialog('edit')}>
                <Pencil /> Edit
              </Button>
            )}
            {can('leads:write') && (
              <Button variant="outline" onClick={() => setDialog('consent')}>
                <ShieldCheck /> Consent
              </Button>
            )}
            <Button variant="outline" onClick={() => setDialog('callback')}>
              <CalendarPlus /> Schedule callback
            </Button>
            {can('whatsapp:send') && (
              <Button variant="outline" onClick={() => setDialog('whatsapp')}>
                <MessageCircle /> WhatsApp
              </Button>
            )}
            {can('leads:delete') && (
              <Button variant="ghost" onClick={() => setDialog('delete')} aria-label="Delete lead">
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
              <KeyValue
                items={[
                  ['Email', lead.email],
                  ['Interest', lead.propertyInterest],
                  ['Location', lead.preferredLocation],
                  ['Budget', formatBudgetRange(lead.budgetMin, lead.budgetMax)],
                  ['Source', lead.source],
                  ['Assigned to', lead.assignedTo ?? 'Unassigned'],
                  ['Created', formatDateTime(lead.createdAt, timezone)],
                ]}
              />
              <KeyValue
                items={[
                  ['Consent', <StatusBadge key="c" value={lead.consentStatus} />],
                  ['Consent source', lead.consentSource],
                  ['Recorded', formatDateTime(lead.consentCapturedAt, timezone)],
                  ['Attempts', lead.attemptCount],
                  ['Last outcome', lead.lastCallOutcome ? titleCase(lead.lastCallOutcome) : null],
                  ['Queue', queueItem ? `${queueItem.queue.name} · ${queueItem.state === 'WAITING' ? `available ${formatDateTime(queueItem.availableAt, timezone)}` : titleCase(queueItem.state)}${queueItem.doneReason ? ` (${titleCase(queueItem.doneReason)})` : ''}` : 'Not queued'],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Calls</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {calls.length ? (
                <ul className="divide-y divide-line">
                  {calls.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link href={`/calls/${c.id}`} className="hover:underline">
                            <CallStatusBadge status={c.status} />
                          </Link>
                          {c.isSimulated && <SimulatedBadge />}
                          {c.outcome && <span className="text-sm font-medium text-ink">{c.outcome.label}</span>}
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          {formatDateTime(c.initiatedAt, timezone)} · {c.agent ?? '—'} · talk {formatDuration(c.talkSeconds)}
                        </p>
                        {c.outcome?.notes && <p className="mt-1 text-sm text-ink-2">{c.outcome.notes}</p>}
                      </div>
                      {can('recordings:play') && c.recordings.map((r) => <RecordingPlayer key={r.id} recordingId={r.id} durationSeconds={r.durationSeconds} />)}
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No calls yet" description="Calls to this lead will be listed here with outcomes and recordings." />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (note.trim()) addNote.mutate();
                }}
              >
                <Textarea aria-label="New note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the team" className="min-h-10" />
                <Button type="submit" loading={addNote.isPending} disabled={!note.trim()}>
                  Add
                </Button>
              </form>
              <ul className="space-y-3">
                {notes.map((n) => (
                  <li key={n.id} className="rounded-lg bg-subtle px-3 py-2">
                    <p className="whitespace-pre-wrap text-sm text-ink">{n.body}</p>
                    <p className="mt-1 text-xs text-muted">
                      {n.author ?? 'System'} · {formatDateTime(n.createdAt, timezone)}
                    </p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Callbacks</CardTitle>
            </CardHeader>
            <CardContent>
              {callbacks.length ? (
                <ul className="space-y-2 text-sm">
                  {callbacks.map((cb) => (
                    <li key={cb.id} className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-ink">{formatDateTime(cb.dueAt, timezone)}</p>
                        {cb.notes && <p className="text-xs text-muted">{cb.notes}</p>}
                      </div>
                      <StatusBadge value={cb.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">None scheduled.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3 border-l border-line pl-4">
                {activity.data?.items.map((a) => (
                  <li key={a.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-line-strong" aria-hidden />
                    <p className="text-sm text-ink">{titleCase(a.type)}</p>
                    {a.data && <p className="text-xs text-muted">{describeActivity(a.data)}</p>}
                    <p className="text-[11px] text-muted">{formatDateTime(a.createdAt, timezone)}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>

      {dialog === 'edit' && <EditLeadDialog lead={lead} onClose={() => setDialog(null)} onSaved={invalidate} />}
      {dialog === 'consent' && <ConsentDialog leadId={id} onClose={() => setDialog(null)} onSaved={invalidate} />}
      {dialog === 'callback' && <CallbackDialog leadId={id} onClose={() => setDialog(null)} onSaved={invalidate} />}
      {dialog === 'whatsapp' && <WhatsAppDialog leadId={id} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
        title="Delete this lead?"
        description="The lead, its notes, calls and callbacks are permanently removed. Consider marking it Closed instead. This cannot be undone."
        destructive
        confirmLabel="Delete lead"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function describeActivity(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    if (['callId', 'importId', 'callbackId', 'seed'].includes(k)) continue;
    parts.push(`${titleCase(k.replace(/([A-Z])/g, '_$1'))}: ${typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toLocaleString('en-IN') : String(v)}`);
  }
  return parts.join(' · ');
}

function EditLeadDialog({ lead, onClose, onSaved }: { lead: Lead; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = React.useState({
    fullName: lead.fullName,
    email: lead.email ?? '',
    propertyInterest: lead.propertyInterest ?? '',
    preferredLocation: lead.preferredLocation ?? '',
    budgetMin: lead.budgetMin?.toString() ?? '',
    budgetMax: lead.budgetMax?.toString() ?? '',
    source: lead.source ?? '',
    priority: lead.priority,
    status: lead.status,
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/leads/${lead.id}`, { ...v, budgetMin: v.budgetMin === '' ? null : Number(v.budgetMin), budgetMax: v.budgetMax === '' ? null : Number(v.budgetMax) }),
    onSuccess: () => {
      toast.success('Lead updated');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Edit lead" wide footer={<Button loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="e-name">
          <Input id="e-name" value={v.fullName} onChange={set('fullName')} />
        </Field>
        <Field label="Email" htmlFor="e-email">
          <Input id="e-email" value={v.email} onChange={set('email')} />
        </Field>
        <Field label="Property interest" htmlFor="e-int">
          <Input id="e-int" value={v.propertyInterest} onChange={set('propertyInterest')} />
        </Field>
        <Field label="Preferred location" htmlFor="e-loc">
          <Input id="e-loc" value={v.preferredLocation} onChange={set('preferredLocation')} />
        </Field>
        <Field label="Budget from (₹)" htmlFor="e-bmin">
          <Input id="e-bmin" type="number" value={v.budgetMin} onChange={set('budgetMin')} />
        </Field>
        <Field label="Budget to (₹)" htmlFor="e-bmax">
          <Input id="e-bmax" type="number" value={v.budgetMax} onChange={set('budgetMax')} />
        </Field>
        <Field label="Source" htmlFor="e-src">
          <Input id="e-src" value={v.source} onChange={set('source')} />
        </Field>
        <Field label="Priority" htmlFor="e-pri">
          <Select id="e-pri" value={v.priority} onChange={set('priority')}>
            {LEAD_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {titleCase(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" htmlFor="e-status" hint="Closed statuses stop dialling for this lead.">
          <Select id="e-status" value={v.status} onChange={set('status')}>
            {LEAD_STATUSES.map((p) => (
              <option key={p} value={p}>
                {titleCase(p)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function ConsentDialog({ leadId, onClose, onSaved }: { leadId: string; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = React.useState<string>('GRANTED');
  const [source, setSource] = React.useState('');
  const [evidence, setEvidence] = React.useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/leads/${leadId}/consent`, { status, source, evidence: evidence || null }),
    onSuccess: () => {
      toast.success('Consent recorded');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record contact permission"
      description="Every change is kept with its source for audit. Withdrawn consent stops calls and messages immediately."
      footer={
        <Button loading={save.isPending} disabled={source.trim().length < 1} onClick={() => save.mutate()}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Status" htmlFor="c-status">
          <Select id="c-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {CONSENT_STATUSES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Source" htmlFor="c-source" required hint="Where did this permission come from?">
          <Input id="c-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Customer confirmed on call, 6 Nov" />
        </Field>
        <Field label="Evidence" htmlFor="c-evidence">
          <Input id="c-evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Form ID, recording, document link" />
        </Field>
      </div>
    </Dialog>
  );
}

function CallbackDialog({ leadId, onClose, onSaved }: { leadId: string; onClose: () => void; onSaved: () => void }) {
  const [dueAt, setDueAt] = React.useState(() => toLocalInput(new Date(Date.now() + 24 * 3600_000)));
  const [notes, setNotes] = React.useState('');
  const save = useMutation({
    mutationFn: () => api.post('/callbacks', { leadId, dueAt: new Date(dueAt).toISOString(), notes: notes || null }),
    onSuccess: () => {
      toast.success('Callback scheduled');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Schedule a callback" footer={<Button loading={save.isPending} onClick={() => save.mutate()}>Schedule</Button>}>
      <div className="space-y-4">
        <Field label="When" htmlFor="cb-at" hint="Your local time. The lead is offered to the assigned agent first when it falls due.">
          <Input id="cb-at" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
        <Field label="Notes" htmlFor="cb-notes">
          <Textarea id="cb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function WhatsAppDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const templates = useQuery({ queryKey: ['whatsapp', 'templates'], queryFn: () => api.get<{ id: string; name: string; category: string; purpose: string; active: boolean }[]>('/whatsapp/templates') });
  const status = useQuery({ queryKey: ['whatsapp', 'status'], queryFn: () => api.get<{ configured: boolean; simulated: boolean }>('/whatsapp/status') });
  const [templateId, setTemplateId] = React.useState('');
  const send = useMutation({
    mutationFn: () => api.post('/whatsapp/send', { leadId, templateId }),
    onSuccess: () => {
      toast.success(status.data?.simulated ? 'Queued (simulated: nothing is actually sent)' : 'WhatsApp message queued');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Send a WhatsApp template"
      description="Only approved templates can be sent. Consent, opt-out and frequency rules are checked before sending."
      footer={
        <Button loading={send.isPending} disabled={!templateId} onClick={() => send.mutate()}>
          Send
        </Button>
      }
    >
      {status.data && !status.data.configured && !status.data.simulated ? (
        <Alert tone="warn">WhatsApp is not configured for your organisation.</Alert>
      ) : (
        <div className="space-y-3">
          {status.data?.simulated && <Alert tone="info">WhatsApp is in simulated mode: messages are recorded but not delivered.</Alert>}
          <Field label="Template" htmlFor="wa-t">
            <Select id="wa-t" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose a template…</option>
              {templates.data
                ?.filter((t) => t.active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({titleCase(t.category)})
                  </option>
                ))}
            </Select>
          </Field>
        </div>
      )}
    </Dialog>
  );
}
