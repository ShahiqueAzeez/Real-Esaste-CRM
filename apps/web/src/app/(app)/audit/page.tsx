'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable, Pagination } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { usePermissions } from '@/lib/session';
import type { Page } from '@/lib/types';

interface AuditRow {
  id: string;
  action: string;
  actor: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export default function AuditPage() {
  const { timezone } = usePermissions();
  const [action, setAction] = React.useState('');
  const a = useDebounced(action);
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [a]);
  const q = useQuery({ queryKey: ['audit', a, page], queryFn: () => api.get<Page<AuditRow>>('/audit', { action: a || undefined, page, pageSize: 50 }), placeholderData: keepPreviousData });
  return (
    <div>
      <PageHeader title="Audit log" description="Sign-ins, member and settings changes, exports, recording access and monitoring. Entries cannot be edited." />
      <Card>
        <div className="border-b border-line p-3">
          <Input aria-label="Filter by action" placeholder="Filter by action prefix, e.g. recording. or lead.exported" value={action} onChange={(e) => setAction(e.target.value)} />
        </div>
        <DataTable
          caption="Audit log"
          rows={q.data?.items}
          loading={q.isLoading}
          columns={[
            { key: 'when', header: 'When', cell: (r) => <span className="text-xs">{formatDateTime(r.createdAt, timezone)}</span> },
            { key: 'action', header: 'Action', cell: (r) => <span className="font-mono text-xs text-ink">{r.action}</span> },
            { key: 'actor', header: 'By', cell: (r) => r.actor ?? '—' },
            { key: 'entity', header: 'Target', cell: (r) => <span className="text-xs">{r.entityType ? `${r.entityType}${r.entityId ? ` ${r.entityId.slice(0, 8)}` : ''}` : '—'}</span> },
            { key: 'meta', header: 'Details', cell: (r) => <span className="line-clamp-2 font-mono text-[11px] text-muted">{r.metadata ? JSON.stringify(r.metadata) : ''}</span> },
          ]}
        />
        {q.data && q.data.total > 0 && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} onPage={setPage} />}
      </Card>
    </div>
  );
}
