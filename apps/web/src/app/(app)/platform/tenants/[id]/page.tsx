'use client';
import { SUBSCRIPTION_STATUSES_UI } from './statuses';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { KeyValue, PageHeader } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatMoneyMinor, titleCase } from '@/lib/format';

interface TenantDetail {
  tenant: { id: string; name: string; slug: string; status: string; suspendedReason: string | null; timezone: string; createdAt: string };
  subscription: { status: string; billingPeriod: string; currentPeriodStart: string; currentPeriodEnd: string; trialEndsAt: string | null; graceDays: number; paymentMode: string; plan: { code: string; name: string; currency: string; monthlyPriceMinor: number; annualPriceMinor: number } } | null;
  integrations: { provider: string; enabled: boolean; status: string; lastError: string | null; lastCheckedAt: string | null }[];
  members: { role: string; status: string; count: number }[];
  ledger: { id: string; type: string; amountMinor: number; currency: string; description: string; reference: string | null; isSimulated: boolean; createdAt: string }[];
  usage30d: { kind: string; isEstimate: boolean; currency: string | null; quantity: number | null; amountMicros: number | null }[];
}

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform', 'tenant', id], queryFn: () => api.get<TenantDetail>(`/platform/tenants/${id}`) });
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<{ code: string; name: string }[]>('/platform/plans') });
  const [suspending, setSuspending] = React.useState(false);
  const [sub, setSub] = React.useState<{ planCode: string; status: string; currentPeriodEnd: string; graceDays: number } | null>(null);
  const [pay, setPay] = React.useState({ amount: '', reference: '', periods: 1, isSimulated: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform'] });
  React.useEffect(() => {
    if (q.data?.subscription && !sub) setSub({ planCode: q.data.subscription.plan.code, status: q.data.subscription.status, currentPeriodEnd: q.data.subscription.currentPeriodEnd.slice(0, 10), graceDays: q.data.subscription.graceDays });
  }, [q.data, sub]);
  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'SUSPENDED') => api.post(`/platform/tenants/${id}/status`, { status, reason: status === 'SUSPENDED' ? 'Suspended by platform administrator' : null }),
    onSuccess: () => {
      setSuspending(false);
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const saveSub = useMutation({
    mutationFn: () => api.patch(`/platform/tenants/${id}/subscription`, { planCode: sub!.planCode, status: sub!.status, currentPeriodEnd: new Date(`${sub!.currentPeriodEnd}T23:59:59Z`).toISOString(), graceDays: sub!.graceDays }),
    onSuccess: () => {
      toast.success('Subscription updated');
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const recordPayment = useMutation({
    mutationFn: () => api.post(`/platform/tenants/${id}/payments`, { amountMinor: Math.round(Number(pay.amount) * 100), reference: pay.reference || undefined, periods: pay.periods, isSimulated: pay.isSimulated }),
    onSuccess: () => {
      toast.success(pay.isSimulated ? 'Simulated payment recorded' : 'Payment recorded');
      setPay({ amount: '', reference: '', periods: 1, isSimulated: false });
      setSub(null);
      void refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.error) return <Alert tone="bad">{errorMessage(q.error)}</Alert>;
  const t = q.data!;
  return (
    <div>
      <Link href="/platform" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Organisations
      </Link>
      <PageHeader
        title={t.tenant.name}
        badge={<StatusBadge value={t.tenant.status} />}
        description={`${t.tenant.slug} · ${t.tenant.timezone} · created ${formatDate(t.tenant.createdAt)}`}
        actions={
          t.tenant.status === 'ACTIVE' ? (
            <Button variant="danger" onClick={() => setSuspending(true)}>
              Suspend
            </Button>
          ) : (
            <Button onClick={() => setStatus.mutate('ACTIVE')} loading={setStatus.isPending}>
              Reactivate
            </Button>
          )
        }
      />
      {t.tenant.suspendedReason && <Alert tone="bad" className="mb-4">{t.tenant.suspendedReason}</Alert>}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Subscription</CardTitle>
            {t.subscription && <StatusBadge value={t.subscription.status} />}
          </CardHeader>
          <CardContent className="space-y-3">
            {t.subscription && sub && (
              <>
                <KeyValue items={[['Plan', t.subscription.plan.name], ['Period', `${formatDate(t.subscription.currentPeriodStart)} – ${formatDate(t.subscription.currentPeriodEnd)}`], ['Payments', titleCase(t.subscription.paymentMode)]]} />
                <Field label="Plan" htmlFor="s-plan">
                  <Select id="s-plan" value={sub.planCode} onChange={(e) => setSub((s) => ({ ...s!, planCode: e.target.value }))}>
                    {plans.data?.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Status" htmlFor="s-status">
                  <Select id="s-status" value={sub.status} onChange={(e) => setSub((s) => ({ ...s!, status: e.target.value }))}>
                    {SUBSCRIPTION_STATUSES_UI.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Paid until" htmlFor="s-end">
                  <Input id="s-end" type="date" value={sub.currentPeriodEnd} onChange={(e) => setSub((s) => ({ ...s!, currentPeriodEnd: e.target.value }))} />
                </Field>
                <Field label="Grace days" htmlFor="s-grace">
                  <Input id="s-grace" type="number" value={sub.graceDays} onChange={(e) => setSub((s) => ({ ...s!, graceDays: Number(e.target.value) }))} />
                </Field>
                <Button size="sm" loading={saveSub.isPending} onClick={() => saveSub.mutate()}>
                  Save subscription
                </Button>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Record a payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Alert tone="info">No payment gateway is connected. Record payments received offline; this extends the paid period.</Alert>
            <Field label={`Amount (${t.subscription?.plan.currency ?? 'INR'})`} htmlFor="p-amt">
              <Input id="p-amt" type="number" min={1} value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} placeholder={t.subscription ? String(t.subscription.plan.monthlyPriceMinor / 100) : ''} />
            </Field>
            <Field label="Reference" htmlFor="p-ref">
              <Input id="p-ref" value={pay.reference} onChange={(e) => setPay((p) => ({ ...p, reference: e.target.value }))} placeholder="Bank transfer UTR" />
            </Field>
            <Field label="Periods paid" htmlFor="p-per">
              <Input id="p-per" type="number" min={1} max={24} value={pay.periods} onChange={(e) => setPay((p) => ({ ...p, periods: Number(e.target.value) }))} />
            </Field>
            <Checkbox label="Simulated payment (development/testing only)" checked={pay.isSimulated} onChange={(e) => setPay((p) => ({ ...p, isSimulated: e.target.checked }))} />
            <Button size="sm" loading={recordPayment.isPending} disabled={!pay.amount} onClick={() => recordPayment.mutate()}>
              Record payment
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Members & integrations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ul className="space-y-1">
              {t.members.map((m) => (
                <li key={`${m.role}-${m.status}`} className="flex justify-between">
                  <span>
                    {titleCase(m.role)} {m.status !== 'ACTIVE' && <Badge>{titleCase(m.status)}</Badge>}
                  </span>
                  <span className="tabular-nums">{m.count}</span>
                </li>
              ))}
            </ul>
            <ul className="space-y-2 border-t border-line pt-3">
              {t.integrations.length ? (
                t.integrations.map((i) => (
                  <li key={i.provider}>
                    <div className="flex justify-between">
                      <span>{titleCase(i.provider)}</span>
                      <StatusBadge value={i.status} />
                    </div>
                    {i.lastError && <p className="text-xs text-bad">{i.lastError}</p>}
                  </li>
                ))
              ) : (
                <li className="text-muted">No provider configured (uses platform or simulated telephony).</li>
              )}
            </ul>
          </CardContent>
        </Card>
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Ledger</CardTitle>
          </CardHeader>
          <DataTable
            caption="Ledger"
            rows={t.ledger}
            columns={[
              { key: 'when', header: 'Date', cell: (e) => formatDateTime(e.createdAt) },
              { key: 'type', header: 'Type', cell: (e) => <span className="space-x-1">{titleCase(e.type)} {e.isSimulated && <Badge tone="sim">SIMULATED</Badge>}</span> },
              { key: 'desc', header: 'Description', cell: (e) => e.description },
              { key: 'ref', header: 'Reference', cell: (e) => e.reference ?? '—' },
              { key: 'amt', header: 'Amount', className: 'text-right', cell: (e) => formatMoneyMinor(e.amountMinor, e.currency) },
            ]}
          />
        </Card>
      </div>
      <ConfirmDialog
        open={suspending}
        onOpenChange={setSuspending}
        title={`Suspend ${t.tenant.name}?`}
        description="Members can no longer use the organisation and agents are taken offline. Data is kept. You can reactivate at any time."
        destructive
        confirmLabel="Suspend"
        loading={setStatus.isPending}
        onConfirm={() => setStatus.mutate('SUSPENDED')}
      />
    </div>
  );
}
