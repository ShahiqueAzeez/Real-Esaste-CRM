'use client';
import Link from 'next/link';
import * as React from 'react';
import { CallsByDayChart, RankedBars } from '@/components/charts/calls-by-day';
import { DateRangeControl, presetRange } from '@/components/date-range';
import { AgentStatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { PageHeader, StatCard } from '@/components/ui/page';
import { errorMessage } from '@/lib/api';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { money, useCallsByDay, useOverview } from '@/lib/reports';

export default function DashboardPage() {
  const [range, setRange] = React.useState(() => ({ ...presetRange('7d'), preset: '7d' }));
  const q = { from: range.from, to: range.to };
  const overview = useOverview(q);
  const byDay = useCallsByDay(q);
  const o = overview.data;
  return (
    <div>
      <PageHeader title="Dashboard" description="Live figures computed from recorded calls, leads and callbacks." actions={<DateRangeControl value={range} onChange={setRange} />} />
      {overview.error && <Alert tone="bad">{errorMessage(overview.error)}</Alert>}
      {o && o.calls.simulated > 0 && (
        <Alert tone="info" className="mb-4" title="Includes simulated calls">
          {o.calls.simulated} of {o.calls.initiated} calls in this period were simulated (no real call placed).
        </Alert>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {o ? (
          <>
            <StatCard label="Total leads" value={formatNumber(o.leads.total)} hint={`${formatNumber(o.leads.createdInRange)} new in period`} />
            <StatCard label="Eligible to call now" value={formatNumber(o.leads.eligibleNow)} />
            <StatCard label="Call attempts" value={formatNumber(o.calls.attempted)} />
            <StatCard label="Answered" value={formatNumber(o.calls.answered)} hint={`Answer rate ${formatPercent(o.calls.answerRate)}`} />
            <StatCard label="Connected to agent" value={formatNumber(o.calls.connected)} />
            <StatCard label="Avg talk time" value={formatDuration(o.calls.averageTalkSeconds)} hint={`${formatDuration(o.calls.talkSeconds)} total`} />
            <StatCard label="Conversions" value={formatNumber(o.conversions)} />
            <StatCard label="Overdue callbacks" value={formatNumber(o.callbacks.overdue)} />
          </>
        ) : (
          Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20" />)
        )}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Call attempts by day</CardTitle>
              <CardDescription>Answered means the customer picked up.</CardDescription>
            </div>
            <Link href="/reports" className="text-xs text-brand hover:underline">
              Full reports
            </Link>
          </CardHeader>
          <CardContent>{byDay.data ? <CallsByDayChart data={byDay.data} /> : <Skeleton className="h-60" />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Outcomes</CardTitle>
          </CardHeader>
          <CardContent>{o ? <RankedBars rows={o.outcomes.map((x) => ({ label: x.label, value: x.count }))} /> : <Skeleton className="h-40" />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Agents right now</CardTitle>
            <Link href="/supervisor" className="text-xs text-brand hover:underline">
              Live board
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {o &&
              ['READY', 'DIALING', 'ON_CALL', 'WRAP_UP', 'PAUSED', 'OFFLINE'].map((s) => (
                <div key={s} className="flex items-center justify-between text-sm">
                  <AgentStatusBadge status={s} />
                  <span className="tabular-nums text-ink">{o.agents[s] ?? 0}</span>
                </div>
              ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Queues</CardTitle>
            <Link href="/queues" className="text-xs text-brand hover:underline">
              Manage
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            {o?.queues.map((qq) => (
              <div key={qq.id} className="text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink">{qq.name}</span>
                  {!qq.active && <Badge tone="warn">Paused</Badge>}
                </div>
                <p className="text-xs text-muted">
                  {formatNumber(qq.eligibleNow)} eligible now · {formatNumber(qq.scheduled)} scheduled · {formatNumber(qq.callbacks)} callbacks · {formatNumber(qq.inProgress)} on calls
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Usage & cost</CardTitle>
              <CardDescription>Provider figures and estimates are shown separately; neither is an invoice.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {o && (
              <>
                <Row label="Billed voice time" value={formatDuration(o.costs.voiceSeconds)} />
                <Row label="Provider-reported cost" value={money(o.costs.providerReported)} />
                <Row label="Estimated cost" value={money(o.costs.estimated)} />
                <Row label="WhatsApp messages" value={formatNumber(o.costs.whatsappMessages)} />
                <Row label="Leads imported" value={formatNumber(o.costs.leadsImported)} />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums text-ink">{value}</span>
    </div>
  );
}
