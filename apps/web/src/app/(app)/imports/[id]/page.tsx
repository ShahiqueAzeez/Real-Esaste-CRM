'use client';
import { LEAD_IMPORT_FIELDS, RealtimeEvent, type ImportProgressPayload, type LeadImportField } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Download } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Skeleton, Spinner } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { PageHeader, StatCard } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { formatBudgetRange, formatNumber, titleCase } from '@/lib/format';
import { useAgents, useQueues } from '@/lib/hooks';
import { useRealtimeEvent } from '@/lib/realtime';

const FIELD_LABEL: Record<LeadImportField, string> = {
  fullName: 'Full name',
  phone: 'Phone',
  email: 'Email',
  propertyInterest: 'Property interest',
  preferredLocation: 'Preferred location',
  budgetMin: 'Budget (from)',
  budgetMax: 'Budget (to)',
  source: 'Source',
  priority: 'Priority',
  consentStatus: 'Consent (yes/no)',
  consentSource: 'Consent source',
  consentCapturedAt: 'Consent date',
  notes: 'Notes',
};

interface ImportJob {
  id: string;
  fileName: string;
  status: string;
  headers: string[];
  sampleRows: string[][];
  mapping: Partial<Record<LeadImportField, string | null>>;
  options: Record<string, unknown> | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  existingRows: number;
  suppressedRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  processedRows: number;
  failureReason: string | null;
  errorSample: { row: number; errors: string[] }[] | null;
  previewRows: { row: number; fullName: string; phoneE164: string; email: string | null; preferredLocation: string | null; budgetMin: number | null; budgetMax: number | null; consentStatus: string | null; existing: boolean; suppressed: boolean }[] | null;
  allowance: { limit: number; used: number; remaining: number };
}

export default function ImportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: ['imports', id],
    queryFn: () => api.get<ImportJob>(`/imports/${id}`),
    refetchInterval: (q) => (['VALIDATING', 'IMPORTING'].includes(q.state.data?.status ?? '') ? 2000 : false),
  });
  const [progress, setProgress] = React.useState<ImportProgressPayload | null>(null);
  useRealtimeEvent<ImportProgressPayload>(RealtimeEvent.IMPORT_PROGRESS, (p) => {
    if (p.importId !== id) return;
    setProgress(p);
    if (['PREVIEW_READY', 'COMPLETED', 'FAILED'].includes(p.status)) void qc.invalidateQueries({ queryKey: ['imports', id] });
  });

  if (job.isLoading) return <Skeleton className="h-96 w-full" />;
  if (job.error) return <Alert tone="bad">{errorMessage(job.error)}</Alert>;
  const j = job.data!;
  return (
    <div>
      <Link href="/imports" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Imports
      </Link>
      <PageHeader title={j.fileName} badge={<StatusBadge value={j.status} />} description={`${formatNumber(j.allowance.remaining)} lead imports left on your plan this month.`} />
      {j.status === 'FAILED' && <Alert tone="bad" className="mb-4" title="Import failed">{j.failureReason}</Alert>}
      {(j.status === 'UPLOADED' || j.status === 'FAILED') && <MappingStep job={j} />}
      {(j.status === 'VALIDATING' || j.status === 'IMPORTING') && (
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <Spinner />
            <div>
              <p className="font-medium text-ink">{j.status === 'VALIDATING' ? 'Checking every row…' : 'Importing leads…'}</p>
              <p className="text-sm text-muted">
                {formatNumber(progress?.processed ?? j.processedRows)} of {formatNumber(progress?.total || j.totalRows || j.validRows)} rows. You can leave this page; we will notify you when it finishes.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {j.status === 'PREVIEW_READY' && <PreviewStep job={j} />}
      {j.status === 'COMPLETED' && (
        <div className="space-y-4">
          <Alert tone="ok" title="Import complete">
            {formatNumber(j.importedRows)} leads added, {formatNumber(j.updatedRows)} updated, {formatNumber(j.skippedRows)} skipped.
          </Alert>
          <Counts j={j} />
          <div className="flex gap-2">
            <Button asChild>
              <Link href="/leads">View leads</Link>
            </Button>
            {(j.invalidRows > 0 || j.duplicateRows > 0) && (
              <Button variant="outline" onClick={() => api.download(`/imports/${id}/errors.csv`)}>
                <Download /> Problem report
              </Button>
            )}
          </div>
        </div>
      )}
      {j.status === 'CANCELLED' && <Alert tone="info">This import was cancelled. Nothing was added.</Alert>}
    </div>
  );
}

function Counts({ j }: { j: ImportJob }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      <StatCard label="Rows" value={formatNumber(j.totalRows)} />
      <StatCard label="Valid" value={formatNumber(j.validRows)} />
      <StatCard label="Problems" value={formatNumber(j.invalidRows)} />
      <StatCard label="Duplicates in file" value={formatNumber(j.duplicateRows)} />
      <StatCard label="Already in CRM" value={formatNumber(j.existingRows)} />
      <StatCard label="On do-not-call list" value={formatNumber(j.suppressedRows)} hint="Imported, never dialled" />
    </div>
  );
}

function MappingStep({ job }: { job: ImportJob }) {
  const qc = useQueryClient();
  const agents = useAgents();
  const queues = useQueues();
  const [mapping, setMapping] = React.useState<Partial<Record<LeadImportField, string | null>>>(job.mapping ?? {});
  const [duplicateStrategy, setDuplicateStrategy] = React.useState<'SKIP' | 'UPDATE'>('SKIP');
  const [queueId, setQueueId] = React.useState('');
  const [assignTo, setAssignTo] = React.useState('');
  const [defaultSource, setDefaultSource] = React.useState('');
  const [attest, setAttest] = React.useState(false);
  const [attestSource, setAttestSource] = React.useState('');
  const [attestEvidence, setAttestEvidence] = React.useState('');
  const submit = useMutation({
    mutationFn: () =>
      api.put(`/imports/${job.id}/mapping`, {
        mapping,
        options: {
          duplicateStrategy,
          queueId: queueId || null,
          assignToMembershipId: assignTo || null,
          defaultSource: defaultSource || null,
          consentAttestation: attest ? { source: attestSource, evidence: attestEvidence || null } : null,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imports', job.id] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ready = !!mapping.fullName && !!mapping.phone && (!attest || attestSource.trim().length >= 3);
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>1. Match your columns</CardTitle>
            <CardDescription>We guessed from the header names. Name and phone are required.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {LEAD_IMPORT_FIELDS.map((f) => (
            <Field key={f} label={FIELD_LABEL[f]} htmlFor={`map-${f}`} required={f === 'fullName' || f === 'phone'}>
              <Select id={`map-${f}`} value={mapping[f] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value || null }))}>
                <option value="">— Not in file —</option>
                {job.headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </CardContent>
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-xs">
            <caption className="px-5 pt-3 text-left text-xs font-medium text-muted">First rows of your file</caption>
            <thead>
              <tr>
                {job.headers.map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold text-ink-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {job.sampleRows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  {job.headers.map((_, c) => (
                    <td key={c} className="max-w-48 truncate px-3 py-1.5 text-muted">
                      {r[c]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>2. Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Numbers already in the CRM" htmlFor="dup">
            <Select id="dup" value={duplicateStrategy} onChange={(e) => setDuplicateStrategy(e.target.value as 'SKIP' | 'UPDATE')}>
              <option value="SKIP">Skip them</option>
              <option value="UPDATE">Update their details</option>
            </Select>
          </Field>
          <Field label="Add to queue" htmlFor="q">
            <Select id="q" value={queueId} onChange={(e) => setQueueId(e.target.value)}>
              <option value="">Default queue</option>
              {queues.data?.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assign to agent" htmlFor="a">
            <Select id="a" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
              <option value="">Leave unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.user.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default source" htmlFor="src" hint="Used when a row has no source">
            <Input id="src" value={defaultSource} onChange={(e) => setDefaultSource(e.target.value)} placeholder="99acres campaign Nov" />
          </Field>
          <div className="rounded-lg border border-line p-3">
            <Checkbox label="I have consent to call these leads" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
            <p className="mt-1 text-xs text-muted">Applies to rows without a consent column value. Recorded per lead with your name. Do not tick this for purchased lists.</p>
            {attest && (
              <div className="mt-3 space-y-3">
                <Field label="Consent source" htmlFor="as" required>
                  <Input id="as" value={attestSource} onChange={(e) => setAttestSource(e.target.value)} placeholder="Opt-in form on project landing page" />
                </Field>
                <Field label="Evidence" htmlFor="ae">
                  <Input id="ae" value={attestEvidence} onChange={(e) => setAttestEvidence(e.target.value)} placeholder="Form export reference" />
                </Field>
              </div>
            )}
          </div>
          <Button className="w-full" disabled={!ready} loading={submit.isPending} onClick={() => submit.mutate()}>
            Validate file
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function PreviewStep({ job }: { job: ImportJob }) {
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => api.post(`/imports/${job.id}/confirm`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['imports', job.id] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/imports/${job.id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['imports', job.id] }) });
  const newLeads = Math.max(0, job.validRows - job.existingRows);
  return (
    <div className="space-y-4">
      <Counts j={job} />
      {newLeads > job.allowance.remaining && <Alert tone="bad">This file adds {formatNumber(newLeads)} new leads but your plan allows {formatNumber(job.allowance.remaining)} more this month.</Alert>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Preview (first valid rows)</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2">Row</th>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Phone</th>
                  <th className="px-4 py-2">Budget</th>
                  <th className="px-4 py-2">Flags</th>
                </tr>
              </thead>
              <tbody>
                {job.previewRows?.map((r) => (
                  <tr key={r.row} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 text-muted">{r.row}</td>
                    <td className="px-4 py-2 text-ink">{r.fullName}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.phoneE164}</td>
                    <td className="px-4 py-2 text-xs">{formatBudgetRange(r.budgetMin, r.budgetMax)}</td>
                    <td className="space-x-1 px-4 py-2">
                      {r.existing && <Badge tone="info">Exists</Badge>}
                      {r.suppressed && <Badge tone="bad">Do not call</Badge>}
                      {r.consentStatus === 'GRANTED' && <Badge tone="ok">Consent</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Problems</CardTitle>
            <Button size="sm" variant="outline" onClick={() => api.download(`/imports/${job.id}/errors.csv`)}>
              <Download /> Full report
            </Button>
          </CardHeader>
          <CardContent className="max-h-96 overflow-y-auto">
            {job.errorSample?.length ? (
              <ul className="space-y-1.5 text-sm">
                {job.errorSample.slice(0, 100).map((e, i) => (
                  <li key={i}>
                    <span className="font-mono text-xs text-muted">Row {e.row}</span> <span className="text-ink-2">{e.errors.join('; ')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-sm text-ok">
                <CheckCircle2 className="size-4" /> No problems found
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => confirm.mutate()} loading={confirm.isPending} disabled={newLeads > job.allowance.remaining || job.validRows === 0}>
          Import {formatNumber(job.validRows)} valid rows
        </Button>
        <Button variant="outline" onClick={() => cancel.mutate()} loading={cancel.isPending}>
          Cancel import
        </Button>
        <span className="self-center text-xs text-muted">Strategy for existing numbers: {titleCase(String((job.options as { duplicateStrategy?: string } | null)?.duplicateStrategy ?? 'SKIP'))}</span>
      </div>
    </div>
  );
}
