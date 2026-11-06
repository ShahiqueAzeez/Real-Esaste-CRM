'use client';
import { SUPPRESSION_CHANNELS, SUPPRESSION_REASONS, type CallingWindow } from '@crm/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { PageHeader, StatCard } from '@/components/ui/page';
import { DataTable, Pagination } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatNumber, titleCase } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { usePermissions } from '@/lib/session';
import { useOrgSettings, useSaveSettings } from '@/lib/settings';
import type { Page } from '@/lib/types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Suppression {
  id: string;
  phoneE164: string;
  channel: string;
  reason: string;
  note: string | null;
  source: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export default function CompliancePage() {
  const { can, timezone } = usePermissions();
  const manage = can('compliance:manage');
  const settingsManage = can('org:settings:manage');
  const qc = useQueryClient();
  const summary = useQuery({ queryKey: ['compliance', 'summary'], queryFn: () => api.get<{ suppressed: number; consent: { granted: number; unknown: number; revoked: number } }>('/compliance/summary') });
  const [q, setQ] = React.useState('');
  const search = useDebounced(q);
  const [page, setPage] = React.useState(1);
  const list = useQuery({ queryKey: ['suppressions', search, page], queryFn: () => api.get<Page<Suppression>>('/compliance/suppressions', { q: search || undefined, page, pageSize: 25 }), placeholderData: keepPreviousData });
  const [adding, setAdding] = React.useState<'one' | 'bulk' | null>(null);
  const [removing, setRemoving] = React.useState<Suppression | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/compliance/suppressions/${id}`),
    onSuccess: () => {
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ['suppressions'] });
      void qc.invalidateQueries({ queryKey: ['compliance'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader title="Compliance" description="Do-not-call list, contact permission and calling rules. These checks run on every reservation and again just before dialling." />
      <Alert tone="info" className="mb-4" title="Your obligations">
        TRAI telemarketing rules (140-series numbers and DLT registration for promotional calls), customer preferences, consent and India’s data protection law apply to your organisation. This software enforces the rules you configure; it does not make your calling compliant by itself.
      </Alert>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Numbers on do-not-call list" value={formatNumber(summary.data?.suppressed)} />
        <StatCard label="Leads with consent" value={formatNumber(summary.data?.consent.granted)} />
        <StatCard label="Consent unknown" value={formatNumber(summary.data?.consent.unknown)} hint="Not dialled while consent is required" />
        <StatCard label="Consent withdrawn" value={formatNumber(summary.data?.consent.revoked)} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Do-not-call and opt-out list</CardTitle>
              <CardDescription>Suppressed numbers are never dialled or messaged, even if re-imported.</CardDescription>
            </div>
            {manage && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setAdding('bulk')}>
                  Bulk add
                </Button>
                <Button size="sm" onClick={() => setAdding('one')}>
                  <Plus /> Add number
                </Button>
              </div>
            )}
          </CardHeader>
          <div className="border-b border-line p-3">
            <Input aria-label="Search numbers" placeholder="Search by number" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <DataTable
            caption="Suppression list"
            rows={list.data?.items}
            loading={list.isLoading}
            empty={<EmptyState icon={ShieldCheck} title="No suppressed numbers" />}
            columns={[
              { key: 'phone', header: 'Number', cell: (s) => <span className="font-mono">{s.phoneE164}</span> },
              { key: 'channel', header: 'Applies to', cell: (s) => titleCase(s.channel) },
              { key: 'reason', header: 'Reason', cell: (s) => <StatusBadge value={s.reason === 'OPT_OUT' || s.reason === 'DO_NOT_CALL' ? 'DO_NOT_CALL' : 'CLOSED'} label={titleCase(s.reason)} /> },
              { key: 'source', header: 'Source', cell: (s) => <span className="text-xs">{s.source ?? '—'}</span> },
              { key: 'when', header: 'Added', cell: (s) => <span className="text-xs">{formatDateTime(s.createdAt, timezone)}</span> },
              ...(manage
                ? [
                    {
                      key: 'rm',
                      header: '',
                      className: 'text-right',
                      cell: (s: Suppression) => (
                        <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setRemoving(s)}>
                          <Trash2 />
                        </Button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {list.data && list.data.total > 0 && <Pagination page={list.data.page} pageCount={list.data.pageCount} total={list.data.total} onPage={setPage} />}
        </Card>
        <div className="space-y-4">{settingsManage ? <RulesEditor /> : <Alert tone="info">Only administrators can change calling rules.</Alert>}</div>
      </div>
      {adding === 'one' && <AddSuppression onClose={() => setAdding(null)} />}
      {adding === 'bulk' && <BulkSuppression onClose={() => setAdding(null)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove from the do-not-call list?"
        description={`${removing?.phoneE164} could be called again if it is queued. Only remove a number when you have evidence the person asked to be contacted. This is logged.`}
        destructive
        confirmLabel="Remove"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />
    </div>
  );
}

function RulesEditor() {
  const settings = useOrgSettings();
  const save = useSaveSettings();
  const [days, setDays] = React.useState<{ on: boolean; start: string; end: string }[] | null>(null);
  const [hoursEnabled, setHoursEnabled] = React.useState(true);
  const [retry, setRetry] = React.useState({ maxAttempts: 3, NO_ANSWER: '', BUSY: '', FAILED: '' });
  const [consent, setConsent] = React.useState({ requireConsentForCalls: true, requireConsentForWhatsApp: true });
  React.useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setHoursEnabled(s.callingHours.enabled);
    setDays(
      DAYS.map((_, d) => {
        const w = s.callingHours.windows.find((x) => x.day === d);
        return { on: !!w, start: w?.start ?? '10:00', end: w?.end ?? '19:00' };
      }),
    );
    setRetry({ maxAttempts: s.retry.maxAttempts, NO_ANSWER: s.retry.delaysMinutes.NO_ANSWER.join(', '), BUSY: s.retry.delaysMinutes.BUSY.join(', '), FAILED: s.retry.delaysMinutes.FAILED.join(', ') });
    setConsent(s.consent);
  }, [settings.data]);
  if (!days) return <Skeleton className="h-96" />;
  const parse = (v: string) => v.split(/[,\s]+/).filter(Boolean).map(Number);
  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Calling hours</CardTitle>
            <CardDescription>In your organisation’s time zone. Retries are pushed into the next open window.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <Checkbox label="Enforce calling hours" checked={hoursEnabled} onChange={(e) => setHoursEnabled(e.target.checked)} />
          {DAYS.map((name, d) => (
            <div key={name} className="flex items-center gap-2 text-sm">
              <Checkbox className="w-28" label={name.slice(0, 3)} checked={days[d]!.on} onChange={(e) => setDays((all) => all!.map((x, i) => (i === d ? { ...x, on: e.target.checked } : x)))} />
              <Input aria-label={`${name} start`} type="time" className="w-28" value={days[d]!.start} disabled={!days[d]!.on} onChange={(e) => setDays((all) => all!.map((x, i) => (i === d ? { ...x, start: e.target.value } : x)))} />
              <span className="text-muted">to</span>
              <Input aria-label={`${name} end`} type="time" className="w-28" value={days[d]!.end} disabled={!days[d]!.on} onChange={(e) => setDays((all) => all!.map((x, i) => (i === d ? { ...x, end: e.target.value } : x)))} />
            </div>
          ))}
          <Button
            className="mt-2"
            size="sm"
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                callingHours: {
                  enabled: hoursEnabled,
                  windows: days.flatMap((x, day): CallingWindow[] => (x.on ? [{ day, start: x.start, end: x.end }] : [])),
                },
              })
            }
          >
            Save hours
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Retries</CardTitle>
            <CardDescription>Minutes to wait before the next attempt; the last value repeats. Leads stop after the maximum attempts.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Maximum attempts per lead" htmlFor="max">
            <Input id="max" type="number" min={1} max={10} value={retry.maxAttempts} onChange={(e) => setRetry((r) => ({ ...r, maxAttempts: Number(e.target.value) }))} />
          </Field>
          {(['NO_ANSWER', 'BUSY', 'FAILED'] as const).map((k) => (
            <Field key={k} label={`After ${titleCase(k).toLowerCase()}`} htmlFor={`r-${k}`}>
              <Input id={`r-${k}`} value={retry[k]} onChange={(e) => setRetry((r) => ({ ...r, [k]: e.target.value }))} placeholder="120, 1440" />
            </Field>
          ))}
          <Button
            size="sm"
            loading={save.isPending}
            onClick={() => save.mutate({ retry: { maxAttempts: retry.maxAttempts, delaysMinutes: { NO_ANSWER: parse(retry.NO_ANSWER), BUSY: parse(retry.BUSY), FAILED: parse(retry.FAILED) } } })}
          >
            Save retries
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Consent requirements</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Checkbox label="Only call leads with recorded consent" checked={consent.requireConsentForCalls} onChange={(e) => setConsent((c) => ({ ...c, requireConsentForCalls: e.target.checked }))} />
          <Checkbox label="Only message leads with recorded consent" checked={consent.requireConsentForWhatsApp} onChange={(e) => setConsent((c) => ({ ...c, requireConsentForWhatsApp: e.target.checked }))} />
          {!consent.requireConsentForCalls && <Alert tone="warn">Calling leads without recorded consent may breach telemarketing rules. Make sure you have another lawful basis.</Alert>}
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ consent })}>
            Save consent rules
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

function AddSuppression({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = React.useState({ phone: '', channel: 'ALL', reason: 'DO_NOT_CALL', note: '' });
  const add = useMutation({
    mutationFn: () => api.post('/compliance/suppressions', { ...v, note: v.note || null }),
    onSuccess: () => {
      toast.success('Number suppressed');
      void qc.invalidateQueries({ queryKey: ['suppressions'] });
      void qc.invalidateQueries({ queryKey: ['compliance'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add to do-not-call list" footer={<Button loading={add.isPending} disabled={!v.phone} onClick={() => add.mutate()}>Add</Button>}>
      <div className="space-y-4">
        <Field label="Phone number" htmlFor="s-phone" required>
          <Input id="s-phone" value={v.phone} onChange={(e) => setV((s) => ({ ...s, phone: e.target.value }))} />
        </Field>
        <Field label="Applies to" htmlFor="s-ch">
          <Select id="s-ch" value={v.channel} onChange={(e) => setV((s) => ({ ...s, channel: e.target.value }))}>
            {SUPPRESSION_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c === 'ALL' ? 'Calls and messages' : titleCase(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason" htmlFor="s-r">
          <Select id="s-r" value={v.reason} onChange={(e) => setV((s) => ({ ...s, reason: e.target.value }))}>
            {SUPPRESSION_REASONS.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" htmlFor="s-n">
          <Input id="s-n" value={v.note} onChange={(e) => setV((s) => ({ ...s, note: e.target.value }))} />
        </Field>
      </div>
    </Dialog>
  );
}

function BulkSuppression({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = React.useState('');
  const phones = text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  const add = useMutation({
    mutationFn: () => api.post<{ added: number; invalidCount: number }>('/compliance/suppressions/bulk', { phones, reason: 'DO_NOT_CALL', channel: 'ALL' }),
    onSuccess: (r) => {
      toast.success(`${r.added} numbers suppressed${r.invalidCount ? `, ${r.invalidCount} invalid skipped` : ''}`);
      void qc.invalidateQueries({ queryKey: ['suppressions'] });
      void qc.invalidateQueries({ queryKey: ['compliance'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Bulk add numbers" description="Paste numbers separated by new lines or commas (for example an NCPR/DND scrub result). Up to 10,000 at a time." footer={<Button loading={add.isPending} disabled={phones.length === 0 || phones.length > 10000} onClick={() => add.mutate()}>Add {phones.length} numbers</Button>}>
      <Textarea aria-label="Numbers" className="min-h-48 font-mono" value={text} onChange={(e) => setText(e.target.value)} />
    </Dialog>
  );
}
