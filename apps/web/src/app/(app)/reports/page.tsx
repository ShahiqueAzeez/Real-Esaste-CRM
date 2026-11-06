'use client';
import { Download } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { CallsByDayChart, RankedBars } from '@/components/charts/calls-by-day';
import { DateRangeControl, presetRange } from '@/components/date-range';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { PageHeader, StatCard } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { useAgents, useQueues } from '@/lib/hooks';
import { money, useAgentReport, useCallsByDay, useOverview, type AgentRow } from '@/lib/reports';
import { usePermissions } from '@/lib/session';

export default function ReportsPage() {
  const { role } = usePermissions();
  const agents = useAgents();
  const queues = useQueues();
  const [range, setRange] = React.useState(() => ({ ...presetRange('30d'), preset: '30d' }));
  const [membershipId, setMembershipId] = React.useState('');
  const [queueId, setQueueId] = React.useState('');
  const q = { from: range.from, to: range.to, membershipId: membershipId || undefined, queueId: queueId || undefined };
  const overview = useOverview(q);
  const byDay = useCallsByDay(q);
  const agentRows = useAgentReport({ from: range.from, to: range.to });
  const o = overview.data;
  return (
    <div>
      <PageHeader
        title="Reports"
        description={role === 'SUPERVISOR' ? 'Figures for the teams you supervise.' : 'All figures are computed from persisted calls, outcomes and callbacks.'}
        actions={
          <Button variant="outline" onClick={() => api.download('/reports/calls.csv', q, 'calls.csv').catch((e) => toast.error(errorMessage(e)))}>
            <Download /> Export calls CSV
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DateRangeControl value={range} onChange={setRange} />
        <Select aria-label="Agent" className="w-48" value={membershipId} onChange={(e) => setMembershipId(e.target.value)}>
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.user.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Queue" className="w-44" value={queueId} onChange={(e) => setQueueId(e.target.value)}>
          <option value="">All queues</option>
          {queues.data?.map((qq) => (
            <option key={qq.id} value={qq.id}>
              {qq.name}
            </option>
          ))}
        </Select>
      </div>
      {overview.error && <Alert tone="bad">{errorMessage(overview.error)}</Alert>}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {o ? (
          <>
            <StatCard label="Calls started" value={formatNumber(o.calls.initiated)} hint={o.calls.simulated ? `${o.calls.simulated} simulated` : undefined} />
            <StatCard label="Attempts (customer dialled)" value={formatNumber(o.calls.attempted)} />
            <StatCard label="Answered by customer" value={formatNumber(o.calls.answered)} hint={formatPercent(o.calls.answerRate)} />
            <StatCard label="Connected agent ↔ customer" value={formatNumber(o.calls.connected)} />
            <StatCard label="Talk time" value={formatDuration(o.calls.talkSeconds)} hint={`avg ${formatDuration(o.calls.averageTalkSeconds)}`} />
            <StatCard label="Agent line failures" value={formatNumber(o.calls.agentUnreachable)} hint="Customer not dialled" />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)
        )}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Attempts by day</CardTitle>
          </CardHeader>
          <CardContent>{byDay.data ? <CallsByDayChart data={byDay.data} height={280} /> : <Skeleton className="h-72" />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Outcomes</CardTitle>
          </CardHeader>
          <CardContent>{o ? <RankedBars rows={o.outcomes.map((x) => ({ label: x.label, value: x.count }))} /> : <Skeleton className="h-40" />}</CardContent>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader>
            <div>
              <CardTitle>Agent productivity</CardTitle>
              <CardDescription>Logged-in time includes ready, dialling, on call, wrap-up and paused.</CardDescription>
            </div>
          </CardHeader>
          <DataTable<AgentRow & { id: string }>
            caption="Agent productivity"
            rows={agentRows.data?.map((a) => ({ ...a, id: a.membershipId }))}
            loading={agentRows.isLoading}
            empty={<EmptyState title="No agents" />}
            columns={[
              { key: 'name', header: 'Agent', cell: (a) => <span className="font-medium text-ink">{a.name}</span> },
              { key: 'att', header: 'Attempts', cell: (a) => formatNumber(a.attempted), className: 'text-right' },
              { key: 'conn', header: 'Connected', cell: (a) => formatNumber(a.connected), className: 'text-right' },
              { key: 'talk', header: 'Talk time', cell: (a) => formatDuration(a.talkSeconds), className: 'text-right' },
              { key: 'avg', header: 'Avg talk', cell: (a) => formatDuration(a.averageTalkSeconds), className: 'text-right' },
              { key: 'pos', header: 'Positive', cell: (a) => formatNumber(a.positiveOutcomes), className: 'text-right' },
              { key: 'conv', header: 'Converted', cell: (a) => formatNumber(a.conversions), className: 'text-right' },
              { key: 'logged', header: 'Logged in', cell: (a) => formatDuration(a.loggedInSeconds), className: 'text-right' },
              { key: 'ready', header: 'Ready', cell: (a) => formatDuration(a.secondsByStatus.READY ?? 0), className: 'text-right' },
              { key: 'wrap', header: 'Wrap-up', cell: (a) => formatDuration(a.secondsByStatus.WRAP_UP ?? 0), className: 'text-right' },
              { key: 'cph', header: 'Calls / hour', cell: (a) => a.callsPerHour ?? '—', className: 'text-right' },
            ]}
          />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Callbacks</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <StatCard label="Scheduled" value={formatNumber(o?.callbacks.scheduled)} />
            <StatCard label="Completed" value={formatNumber(o?.callbacks.completed)} hint={o ? `${formatNumber(o.callbacks.completedOnTime)} on time` : undefined} />
            <StatCard label="Overdue" value={formatNumber(o?.callbacks.overdue)} />
            <StatCard label="Cancelled" value={formatNumber(o?.callbacks.cancelled)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Queue processing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {o?.queues.map((qq) => (
              <div key={qq.id} className="flex justify-between gap-2">
                <span className="text-ink">{qq.name}</span>
                <span className="text-xs tabular-nums text-muted">
                  {formatNumber(qq.eligibleNow)} eligible · {formatNumber(qq.done)} finished
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Usage & cost</CardTitle>
              <CardDescription>{o?.costs.note}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {[
              ['Billed voice time', formatDuration(o?.costs.voiceSeconds ?? 0)],
              ['Provider-reported cost', o ? money(o.costs.providerReported) : '—'],
              ['Estimated cost', o ? money(o.costs.estimated) : '—'],
              ['WhatsApp messages', formatNumber(o?.costs.whatsappMessages)],
              ['Recording time', formatDuration(o?.costs.recordingSeconds ?? 0)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-muted">{k}</span>
                <span className="tabular-nums text-ink">{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
