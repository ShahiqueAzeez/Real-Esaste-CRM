'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { PageHeader, StatCard } from '@/components/ui/page';
import { DataTable, Pagination } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, toLocalInput } from '@/lib/format';
import { usePermissions } from '@/lib/session';
import type { Page } from '@/lib/types';

interface CallbackRow {
  id: string;
  dueAt: string;
  status: string;
  notes: string | null;
  overdue: boolean;
  assignee: string | null;
  lead: { id: string; fullName: string; status: string };
}

export default function CallbacksPage() {
  const { can, role, timezone } = usePermissions();
  const qc = useQueryClient();
  const [tab, setTab] = React.useState<'overdue' | 'pending' | 'done'>('pending');
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<CallbackRow | null>(null);
  const [dueAt, setDueAt] = React.useState('');
  React.useEffect(() => setPage(1), [tab]);
  const query = { page, pageSize: 25, ...(tab === 'overdue' ? { overdue: 'true' } : tab === 'pending' ? { status: 'PENDING' } : { status: 'COMPLETED' }) };
  const list = useQuery({ queryKey: ['callbacks', query], queryFn: () => api.get<Page<CallbackRow>>('/callbacks', query), placeholderData: keepPreviousData });
  const summary = useQuery({ queryKey: ['callbacks', 'summary'], queryFn: () => api.get<{ overdue: number; dueSoon: number; pending: number }>('/callbacks/summary') });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/callbacks/${id}`, body),
    onSuccess: () => {
      toast.success('Callback updated');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['callbacks'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader title="Callbacks" description={role === 'AGENT' ? 'Callbacks assigned to you. Due callbacks are offered to you before other leads.' : 'Scheduled callbacks across your team.'} />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatCard label="Overdue" value={summary.data?.overdue ?? '—'} />
        <StatCard label="Due within an hour" value={summary.data?.dueSoon ?? '—'} />
        <StatCard label="Pending" value={summary.data?.pending ?? '—'} />
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="mb-3">
          <TabsTrigger value="pending">Upcoming</TabsTrigger>
          <TabsTrigger value="overdue">Overdue</TabsTrigger>
          <TabsTrigger value="done">Completed</TabsTrigger>
        </TabsList>
      </Tabs>
      <Card>
        <DataTable
          caption="Callbacks"
          rows={list.data?.items}
          loading={list.isLoading}
          empty={<EmptyState icon={CalendarClock} title="Nothing here" description="Callbacks are created from the wrap-up form or a lead's page." />}
          columns={[
            {
              key: 'due',
              header: 'Due',
              cell: (r) => (
                <span className={r.overdue ? 'font-medium text-bad' : ''}>
                  {formatDateTime(r.dueAt, timezone)} {r.overdue && <Badge tone="bad">Overdue</Badge>}
                </span>
              ),
            },
            { key: 'lead', header: 'Lead', cell: (r) => <Link href={`/leads/${r.lead.id}`} className="font-medium text-ink hover:underline">{r.lead.fullName}</Link> },
            ...(role !== 'AGENT' ? [{ key: 'assignee', header: 'Agent', cell: (r: CallbackRow) => r.assignee ?? '—' }] : []),
            { key: 'notes', header: 'Notes', cell: (r) => <span className="line-clamp-2 text-xs">{r.notes ?? '—'}</span> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
            {
              key: 'actions',
              header: '',
              className: 'text-right',
              cell: (r) =>
                can('callbacks:manage') && r.status === 'PENDING' ? (
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(r);
                        setDueAt(toLocalInput(new Date(Math.max(Date.parse(r.dueAt), Date.now() + 3600_000))));
                      }}
                    >
                      Reschedule
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: r.id, body: { status: 'CANCELLED' } })}>
                      Cancel
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
        {list.data && list.data.total > 0 && <Pagination page={list.data.page} pageCount={list.data.pageCount} total={list.data.total} onPage={setPage} />}
      </Card>
      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Reschedule callback"
        footer={
          <Button loading={update.isPending} onClick={() => editing && update.mutate({ id: editing.id, body: { dueAt: new Date(dueAt).toISOString() } })}>
            Save
          </Button>
        }
      >
        <Field label="New time" htmlFor="resched">
          <Input id="resched" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
