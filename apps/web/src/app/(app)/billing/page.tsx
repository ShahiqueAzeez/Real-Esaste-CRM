'use client';
import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { KeyValue, PageHeader } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, formatMoneyMinor, formatNumber, titleCase } from '@/lib/format';
import { usePermissions } from '@/lib/session';

interface Billing {
  subscription: { status: string; operational: boolean; billingPeriod: string; currentPeriodStart: string; currentPeriodEnd: string; trialEndsAt: string | null; graceDays: number; paymentMode: string };
  plan: { code: string; name: string; currency: string; monthlyPriceMinor: number; annualPriceMinor: number; features: Record<string, boolean> };
  limits: Record<string, { used: number; limit: number }>;
  ledger: { id: string; type: string; amountMinor: number; currency: string; description: string; reference: string | null; isSimulated: boolean; createdAt: string }[];
  balanceMinor: number;
  paymentCollection: { configured: boolean; message: string };
}

const LIMIT_LABEL: Record<string, string> = { agents: 'Active agents', leadImportsThisMonth: 'Lead imports this month', concurrentCalls: 'Simultaneous calls' };

export default function BillingPage() {
  const { timezone } = usePermissions();
  const q = useQuery({ queryKey: ['billing'], queryFn: () => api.get<Billing>('/billing') });
  if (!q.data) return <Skeleton className="h-96 w-full" />;
  const b = q.data;
  return (
    <div>
      <PageHeader title="Billing" description="Your software subscription. Telephony and WhatsApp usage are billed by those providers separately." />
      <Alert tone="info" className="mb-4">{b.paymentCollection.message}</Alert>
      {!b.subscription.operational && <Alert tone="bad" className="mb-4" title="Subscription inactive">Calling, imports and invitations are paused until the subscription is renewed.</Alert>}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{b.plan.name} plan</CardTitle>
            <StatusBadge value={b.subscription.status} />
          </CardHeader>
          <CardContent>
            <KeyValue
              items={[
                ['Price', `${formatMoneyMinor(b.plan.monthlyPriceMinor, b.plan.currency)} / month or ${formatMoneyMinor(b.plan.annualPriceMinor, b.plan.currency)} / year`],
                ['Billing period', titleCase(b.subscription.billingPeriod)],
                ['Current period', `${formatDate(b.subscription.currentPeriodStart, timezone)} – ${formatDate(b.subscription.currentPeriodEnd, timezone)}`],
                ['Trial ends', b.subscription.trialEndsAt ? formatDate(b.subscription.trialEndsAt, timezone) : null],
                ['Grace period', `${b.subscription.graceDays} days`],
                ['Payments', b.subscription.paymentMode === 'SIMULATED' ? 'Simulated (development)' : 'Recorded manually'],
              ]}
            />
            <div className="mt-4 flex flex-wrap gap-1.5">
              {Object.entries(b.plan.features).map(([k, on]) => (
                <Badge key={k} tone={on ? 'ok' : 'neutral'}>
                  {titleCase(k.replace(/([A-Z])/g, '_$1'))}: {on ? 'included' : 'not included'}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Usage against plan limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {Object.entries(b.limits).map(([k, v]) => {
              const pct = v.limit ? Math.min(100, Math.round((v.used / v.limit) * 100)) : 0;
              return (
                <div key={k}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="text-ink-2">{LIMIT_LABEL[k] ?? k}</span>
                    <span className="tabular-nums text-ink">
                      {formatNumber(v.used)} / {formatNumber(v.limit)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-subtle" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={LIMIT_LABEL[k] ?? k}>
                    <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--color-bad)' : '#2a78d6' }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Billing ledger</CardTitle>
            <span className="text-sm text-muted">Balance: {formatMoneyMinor(b.balanceMinor, b.plan.currency)}</span>
          </CardHeader>
          <DataTable
            caption="Billing ledger"
            rows={b.ledger}
            empty={<EmptyState title="No ledger entries yet" />}
            columns={[
              { key: 'when', header: 'Date', cell: (e) => formatDateTime(e.createdAt, timezone) },
              { key: 'type', header: 'Type', cell: (e) => <span className="space-x-1">{titleCase(e.type)} {e.isSimulated && <Badge tone="sim">SIMULATED</Badge>}</span> },
              { key: 'desc', header: 'Description', cell: (e) => e.description },
              { key: 'ref', header: 'Reference', cell: (e) => e.reference ?? '—' },
              { key: 'amt', header: 'Amount', className: 'text-right', cell: (e) => formatMoneyMinor(e.amountMinor, e.currency) },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
