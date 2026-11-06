'use client';
import { CALL_STATUSES } from '@crm/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { CallStatusBadge } from '@/components/status';
import { Badge, SimulatedBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable, Pagination } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration, formatMoneyMicros, titleCase } from '@/lib/format';
import { useAgents } from '@/lib/hooks';
import { usePermissions } from '@/lib/session';
import type { Page } from '@/lib/types';

export interface CallRow {
  id: string;
  status: string;
  isSimulated: boolean;
  initiatedAt: string;
  talkSeconds: number | null;
  costMicros: number | null;
  costCurrency: string | null;
  costSource: string;
  failureReason: string | null;
  wrapUpStatus: string;
  attemptNumber: number;
  agent: { id: string; name: string | null };
  lead: { id: string; fullName: string; phone: string };
  outcome: { outcomeCode: string; outcomeLabel: string } | null;
  recordings: { id: string }[];
}

export default function CallsPage() {
  const { role, timezone } = usePermissions();
  const router = useRouter();
  const agents = useAgents();
  const [page, setPage] = React.useState(1);
  const [f, setF] = React.useState({ status: '', membershipId: '', from: '', to: '' });
  React.useEffect(() => setPage(1), [f]);
  const query = {
    page,
    pageSize: 25,
    status: f.status || undefined,
    membershipId: f.membershipId || undefined,
    from: f.from ? new Date(f.from).toISOString() : undefined,
    to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : undefined,
  };
  const calls = useQuery({ queryKey: ['calls', query], queryFn: () => api.get<Page<CallRow>>('/calls', query), placeholderData: keepPreviousData, refetchInterval: 20_000 });
  return (
    <div>
      <PageHeader title={role === 'AGENT' ? 'My calls' : 'Calls'} description="Every attempt with its authoritative provider status, outcome and cost. Estimated costs are labelled." />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select aria-label="Status" className="w-48" value={f.status} onChange={(e) => setF((s) => ({ ...s, status: e.target.value }))}>
            <option value="">All statuses</option>
            {CALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </Select>
          {role !== 'AGENT' && (
            <Select aria-label="Agent" className="w-48" value={f.membershipId} onChange={(e) => setF((s) => ({ ...s, membershipId: e.target.value }))}>
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.user.name}
                </option>
              ))}
            </Select>
          )}
          <Input aria-label="From date" type="date" className="w-40" value={f.from} onChange={(e) => setF((s) => ({ ...s, from: e.target.value }))} />
          <Input aria-label="To date" type="date" className="w-40" value={f.to} onChange={(e) => setF((s) => ({ ...s, to: e.target.value }))} />
        </div>
        <DataTable
          caption="Calls"
          rows={calls.data?.items}
          loading={calls.isLoading}
          onRowClick={(c) => router.push(`/calls/${c.id}`)}
          empty={<EmptyState icon={PhoneCall} title="No calls found" description="Calls appear here as soon as they are placed." />}
          columns={[
            { key: 'when', header: 'Started', cell: (c) => <span className="text-xs">{formatDateTime(c.initiatedAt, timezone)}</span> },
            {
              key: 'lead',
              header: 'Lead',
              cell: (c) => (
                <div>
                  <p className="font-medium text-ink">{c.lead.fullName}</p>
                  <p className="font-mono text-xs text-muted">{c.lead.phone}</p>
                </div>
              ),
            },
            ...(role !== 'AGENT' ? [{ key: 'agent', header: 'Agent', cell: (c: CallRow) => c.agent.name ?? '—' }] : []),
            {
              key: 'status',
              header: 'Status',
              cell: (c) => (
                <div className="flex flex-wrap items-center gap-1">
                  <CallStatusBadge status={c.status} />
                  {c.isSimulated && <SimulatedBadge />}
                  {c.wrapUpStatus === 'PENDING' && ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'].includes(c.status) && <Badge tone="warn">Wrap-up pending</Badge>}
                </div>
              ),
            },
            { key: 'outcome', header: 'Outcome', cell: (c) => c.outcome?.outcomeLabel ?? '—' },
            { key: 'talk', header: 'Talk', cell: (c) => formatDuration(c.talkSeconds), className: 'text-right' },
            {
              key: 'cost',
              header: 'Cost',
              className: 'text-right',
              cell: (c) =>
                c.costMicros == null ? (
                  '—'
                ) : (
                  <span title={c.costSource === 'PROVIDER' ? 'Reported by the provider' : 'Estimate from your configured rates'}>
                    {formatMoneyMicros(c.costMicros, c.costCurrency)} {c.costSource !== 'PROVIDER' && <span className="text-xs text-muted">est.</span>}
                  </span>
                ),
            },
          ]}
        />
        {calls.data && calls.data.total > 0 && <Pagination page={calls.data.page} pageCount={calls.data.pageCount} total={calls.data.total} onPage={setPage} />}
      </Card>
    </div>
  );
}
