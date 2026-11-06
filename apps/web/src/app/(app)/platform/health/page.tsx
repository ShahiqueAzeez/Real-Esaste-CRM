'use client';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { StatusBadge } from '@/components/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { PageHeader, StatCard } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';

interface Health {
  database: string;
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
  unprocessedCallEvents: number;
  stuckCalls: number;
  integrationFailures: { provider: string; lastError: string; lastCheckedAt: string | null; updatedAt: string; tenant: { id: string; name: string } }[];
}

export default function HealthPage() {
  const q = useQuery({ queryKey: ['platform', 'health'], queryFn: () => api.get<Health>('/platform/health'), refetchInterval: 15_000 });
  if (q.error) return <Alert tone="bad">{errorMessage(q.error)}</Alert>;
  if (!q.data) return <Skeleton className="h-96 w-full" />;
  const h = q.data;
  return (
    <div>
      <PageHeader title="System health" description="Refreshes every 15 seconds." />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Database" value={<StatusBadge value={h.database === 'ok' ? 'ACTIVE' : 'ERROR'} label={h.database} />} />
        <StatCard label="Unprocessed call events" value={h.unprocessedCallEvents} hint="Older than 1 minute" />
        <StatCard label="Stuck calls" value={h.stuckCalls} hint="Ringing for over 10 minutes" />
        <StatCard label="Integration errors" value={h.integrationFailures.length} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Background queues</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-1">Queue</th>
                  <th className="py-1 text-right">Waiting</th>
                  <th className="py-1 text-right">Active</th>
                  <th className="py-1 text-right">Delayed</th>
                  <th className="py-1 text-right">Failed</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(h.queues).map(([name, c]) => (
                  <tr key={name} className="border-t border-line">
                    <td className="py-1.5 font-medium text-ink">{name}</td>
                    <td className="py-1.5 text-right tabular-nums">{c.waiting}</td>
                    <td className="py-1.5 text-right tabular-nums">{c.active}</td>
                    <td className="py-1.5 text-right tabular-nums">{c.delayed}</td>
                    <td className={`py-1.5 text-right tabular-nums ${c.failed ? 'text-bad' : ''}`}>{c.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent integration failures</CardTitle>
          </CardHeader>
          <CardContent>
            {h.integrationFailures.length ? (
              <ul className="space-y-3 text-sm">
                {h.integrationFailures.map((f) => (
                  <li key={`${f.tenant.id}-${f.provider}`}>
                    <p className="font-medium text-ink">
                      {f.tenant.name} · {titleCase(f.provider)}
                    </p>
                    <p className="text-xs text-bad">{f.lastError}</p>
                    <p className="text-xs text-muted">{formatDateTime(f.lastCheckedAt ?? f.updatedAt)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No integration errors reported.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
