'use client';
import { CONSENT_STATUSES, LEAD_PRIORITIES, LEAD_STATUSES, type LeadListQuery } from '@crm/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Search, Upload, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable, Pagination, type Column, type SortState } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { useAgents, useDebounced, useQueues } from '@/lib/hooks';
import { usePermissions } from '@/lib/session';
import type { Lead, Page } from '@/lib/types';
import { NewLeadDialog } from './lead-form';

export default function LeadsPage() {
  const { can, role, timezone } = usePermissions();
  const router = useRouter();
  const qc = useQueryClient();
  const agents = useAgents();
  const queues = useQueues();
  const [q, setQ] = React.useState('');
  const search = useDebounced(q);
  const [filters, setFilters] = React.useState<Partial<LeadListQuery>>({});
  const [sort, setSort] = React.useState<SortState>({ sort: 'createdAt', order: 'desc' });
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [creating, setCreating] = React.useState(false);
  const [bulk, setBulk] = React.useState<{ action: 'assign' | 'status' | 'queue' | ''; value: string }>({ action: '', value: '' });

  React.useEffect(() => setPage(1), [search, filters, sort]);
  const params = { ...filters, q: search || undefined, page, pageSize: 25, sort: sort.sort, order: sort.order };
  const leads = useQuery({ queryKey: ['leads', params], queryFn: () => api.get<Page<Lead>>('/leads', params), placeholderData: keepPreviousData });

  const runBulk = useMutation({
    mutationFn: async () => {
      const leadIds = [...selected];
      if (bulk.action === 'assign') return api.post<{ updated: number; skipped: number }>('/leads/bulk/assign', { leadIds, membershipId: bulk.value || null });
      if (bulk.action === 'status') return api.post<{ updated: number; skipped: number }>('/leads/bulk/status', { leadIds, status: bulk.value });
      return api.post<{ queued: number; skipped: Record<string, number> }>('/leads/bulk/queue', { leadIds, queueId: bulk.value });
    },
    onSuccess: (r) => {
      const res = r as { updated?: number; queued?: number; skipped?: number | Record<string, number> };
      const skipped = typeof res.skipped === 'number' ? res.skipped : Object.values(res.skipped ?? {}).reduce((a, b) => a + b, 0);
      toast.success(`${res.updated ?? res.queued ?? 0} updated${skipped ? `, ${skipped} skipped` : ''}`);
      if (res.skipped && typeof res.skipped === 'object' && skipped) toast.info(`Skipped: ${Object.entries(res.skipped).map(([k, v]) => `${titleCase(k)} ${v}`).join(', ')}`);
      setSelected(new Set());
      setBulk({ action: '', value: '' });
      void qc.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const columns: Column<Lead>[] = [
    {
      key: 'name',
      header: 'Lead',
      sortKey: 'fullName',
      cell: (l) => (
        <div className="min-w-0">
          <Link href={`/leads/${l.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
            {l.fullName}
          </Link>
          <p className="font-mono text-xs text-muted">{l.phoneE164}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (l) => <StatusBadge value={l.status} /> },
    { key: 'priority', header: 'Priority', sortKey: 'priority', cell: (l) => <StatusBadge value={l.priority} /> },
    { key: 'consent', header: 'Consent', cell: (l) => <StatusBadge value={l.consentStatus} /> },
    { key: 'interest', header: 'Interest', cell: (l) => <span className="text-xs">{[l.propertyInterest, l.preferredLocation].filter(Boolean).join(' · ') || '—'}</span> },
    ...(role !== 'AGENT' ? [{ key: 'assigned', header: 'Agent', cell: (l: Lead) => l.assignedTo ?? <span className="text-muted">Unassigned</span> }] : []),
    { key: 'attempts', header: 'Attempts', sortKey: 'attemptCount', cell: (l) => <span className="tabular-nums">{l.attemptCount}</span>, className: 'text-right' },
    { key: 'last', header: 'Last call', sortKey: 'lastCallAt', cell: (l) => <span className="text-xs">{l.lastCallAt ? formatDateTime(l.lastCallAt, timezone) : '—'}</span> },
    {
      key: 'queue',
      header: 'Dialling',
      cell: (l) => (l.queueItem ? <StatusBadge value={l.queueItem.state === 'WAITING' ? (l.queueItem.isCallback ? 'CALLBACK' : 'QUEUED') : l.queueItem.state === 'DONE' ? 'COMPLETED' : 'IMPORTING'} label={l.queueItem.state === 'DONE' ? `Done${l.queueItem.doneReason ? ` (${titleCase(l.queueItem.doneReason)})` : ''}` : l.queueItem.state === 'WAITING' ? (new Date(l.queueItem.availableAt) > new Date() ? `Next ${formatDateTime(l.queueItem.availableAt, timezone)}` : 'Ready') : 'On a call'} /> : '—'),
    },
  ];

  const canBulk = can('leads:assign') || can('leads:write');
  return (
    <div>
      <PageHeader
        title={role === 'AGENT' ? 'My leads' : 'Leads'}
        description={role === 'AGENT' ? 'Leads assigned to you or that you have called. Numbers are partly hidden; the system dials for you.' : 'Search, filter and manage every lead in your organisation.'}
        actions={
          <>
            {can('leads:export') && (
              <Button variant="outline" onClick={() => api.download('/leads/export', { ...filters, q: search || undefined }, 'leads.csv').catch((e) => toast.error(errorMessage(e)))}>
                <Download /> Export CSV
              </Button>
            )}
            {can('leads:import') && (
              <Button variant="outline" asChild>
                <Link href="/imports">
                  <Upload /> Import
                </Link>
              </Button>
            )}
            {can('leads:write') && (
              <Button onClick={() => setCreating(true)}>
                <Plus /> New lead
              </Button>
            )}
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input aria-label="Search leads" placeholder="Search name, phone, email or location" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Status" className="w-40" value={filters.status ?? ''} onChange={(e) => setFilters((f) => ({ ...f, status: (e.target.value || undefined) as LeadListQuery['status'] }))}>
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </Select>
          <Select aria-label="Priority" className="w-36" value={filters.priority ?? ''} onChange={(e) => setFilters((f) => ({ ...f, priority: (e.target.value || undefined) as LeadListQuery['priority'] }))}>
            <option value="">Any priority</option>
            {LEAD_PRIORITIES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </Select>
          <Select aria-label="Consent" className="w-40" value={filters.consentStatus ?? ''} onChange={(e) => setFilters((f) => ({ ...f, consentStatus: (e.target.value || undefined) as LeadListQuery['consentStatus'] }))}>
            <option value="">Any consent</option>
            {CONSENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                Consent: {titleCase(s)}
              </option>
            ))}
          </Select>
          {role !== 'AGENT' && (
            <Select aria-label="Agent" className="w-44" value={filters.assignedMembershipId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, assignedMembershipId: e.target.value || undefined }))}>
              <option value="">Any agent</option>
              <option value="unassigned">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.user.name}
                </option>
              ))}
            </Select>
          )}
          {role !== 'AGENT' && (
            <Select aria-label="Queue" className="w-40" value={filters.queueId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, queueId: e.target.value || undefined }))}>
              <option value="">Any queue</option>
              {queues.data?.map((qq) => (
                <option key={qq.id} value={qq.id}>
                  {qq.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        {canBulk && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-soft/40 p-3 text-sm">
            <span className="font-medium text-ink">{selected.size} selected</span>
            <Select aria-label="Bulk action" className="w-44" value={bulk.action} onChange={(e) => setBulk({ action: e.target.value as typeof bulk.action, value: '' })}>
              <option value="">Choose action…</option>
              {can('leads:assign') && <option value="assign">Assign to agent</option>}
              {can('leads:write') && <option value="status">Set status</option>}
              {can('leads:assign') && <option value="queue">Add to queue</option>}
            </Select>
            {bulk.action === 'assign' && (
              <Select aria-label="Agent" className="w-48" value={bulk.value} onChange={(e) => setBulk((b) => ({ ...b, value: e.target.value }))}>
                <option value="">Unassign</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.user.name}
                  </option>
                ))}
              </Select>
            )}
            {bulk.action === 'status' && (
              <Select aria-label="Status" className="w-44" value={bulk.value} onChange={(e) => setBulk((b) => ({ ...b, value: e.target.value }))}>
                <option value="">Choose status…</option>
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {titleCase(s)}
                  </option>
                ))}
              </Select>
            )}
            {bulk.action === 'queue' && (
              <Select aria-label="Queue" className="w-44" value={bulk.value} onChange={(e) => setBulk((b) => ({ ...b, value: e.target.value }))}>
                <option value="">Choose queue…</option>
                {queues.data?.map((qq) => (
                  <option key={qq.id} value={qq.id}>
                    {qq.name}
                  </option>
                ))}
              </Select>
            )}
            <Button size="sm" disabled={!bulk.action || (bulk.action !== 'assign' && !bulk.value)} loading={runBulk.isPending} onClick={() => runBulk.mutate()}>
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
        <DataTable
          caption="Leads"
          columns={columns}
          rows={leads.data?.items}
          loading={leads.isLoading}
          sort={sort}
          onSort={setSort}
          selectable={canBulk}
          selected={selected}
          onSelectedChange={setSelected}
          onRowClick={(l) => router.push(`/leads/${l.id}`)}
          empty={
            <EmptyState
              icon={Users}
              title={search || Object.values(filters).some(Boolean) ? 'No leads match these filters' : 'No leads yet'}
              description={can('leads:import') ? 'Import a CSV file or add leads one by one.' : 'Leads assigned to you will appear here.'}
              action={can('leads:import') ? <Button asChild variant="outline"><Link href="/imports">Import leads</Link></Button> : undefined}
            />
          }
        />
        {leads.data && leads.data.total > 0 && <Pagination page={leads.data.page} pageCount={leads.data.pageCount} total={leads.data.total} onPage={setPage} />}
      </Card>
      {can('leads:write') && <NewLeadDialog open={creating} onOpenChange={setCreating} />}
    </div>
  );
}
