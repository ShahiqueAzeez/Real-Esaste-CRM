'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable, Pagination } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/format';
import type { Page } from '@/lib/types';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  subscription: { status: string; plan: string; currentPeriodEnd: string } | null;
  activeAgents: number;
  leads: number;
  callAttempts30d: number;
}

export default function PlatformPage() {
  const router = useRouter();
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);
  const q = useQuery({ queryKey: ['platform', 'tenants', page], queryFn: () => api.get<Page<TenantRow>>('/platform/tenants', { page, pageSize: 25 }) });
  return (
    <div>
      <PageHeader
        title="Organisations"
        description="Customer organisations on the platform. Their leads, calls and recordings are never visible here."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New organisation
          </Button>
        }
      />
      {q.error && <Alert tone="bad">{errorMessage(q.error)}</Alert>}
      {link && (
        <Alert tone="warn" className="mb-4" title="Administrator invitation link">
          <p className="mb-2">Email is not configured. Send this one-time link to the organisation’s administrator through a secure channel.</p>
          <div className="flex gap-2">
            <Input readOnly value={link} aria-label="Invitation link" />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(link);
                toast.success('Copied');
              }}
            >
              <Copy /> Copy
            </Button>
          </div>
        </Alert>
      )}
      <Card>
        <DataTable
          caption="Organisations"
          rows={q.data?.items}
          loading={q.isLoading}
          onRowClick={(t) => router.push(`/platform/tenants/${t.id}`)}
          empty={<EmptyState icon={Building2} title="No organisations yet" />}
          columns={[
            {
              key: 'name',
              header: 'Organisation',
              cell: (t) => (
                <div>
                  <p className="font-medium text-ink">{t.name}</p>
                  <p className="text-xs text-muted">{t.slug}</p>
                </div>
              ),
            },
            { key: 'status', header: 'Status', cell: (t) => <StatusBadge value={t.status} /> },
            { key: 'plan', header: 'Plan', cell: (t) => (t.subscription ? `${t.subscription.plan}` : '—') },
            { key: 'sub', header: 'Subscription', cell: (t) => (t.subscription ? <StatusBadge value={t.subscription.status} /> : '—') },
            { key: 'period', header: 'Paid until', cell: (t) => formatDate(t.subscription?.currentPeriodEnd) },
            { key: 'agents', header: 'Agents', className: 'text-right', cell: (t) => formatNumber(t.activeAgents) },
            { key: 'leads', header: 'Leads', className: 'text-right', cell: (t) => formatNumber(t.leads) },
            { key: 'calls', header: 'Attempts (30d)', className: 'text-right', cell: (t) => formatNumber(t.callAttempts30d) },
          ]}
        />
        {q.data && q.data.total > 0 && <Pagination page={q.data.page} pageCount={q.data.pageCount} total={q.data.total} onPage={setPage} />}
      </Card>
      {creating && <CreateTenant onClose={() => setCreating(false)} onLink={setLink} />}
    </div>
  );
}

function CreateTenant({ onClose, onLink }: { onClose: () => void; onLink: (l: string | null) => void }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<{ id: string; code: string; name: string; active: boolean }[]>('/platform/plans') });
  const [v, setV] = React.useState({ name: '', slug: '', timezone: 'Asia/Kolkata', planCode: '', billingPeriod: 'MONTHLY', trialDays: 14, adminEmail: '' });
  const create = useMutation({
    mutationFn: () => api.post<{ adminInvitation: { emailDelivered: boolean; inviteLink: string | null } }>('/platform/tenants', { ...v, planCode: v.planCode || plans.data?.find((p) => p.active)?.code }),
    onSuccess: (r) => {
      toast.success('Organisation created');
      onLink(r.adminInvitation.inviteLink);
      void qc.invalidateQueries({ queryKey: ['platform'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New organisation" description="Creates the organisation, default outcomes and queue, a subscription, and an invitation for its first administrator." footer={<Button loading={create.isPending} disabled={!v.name || !v.slug || !v.adminEmail} onClick={() => create.mutate()}>Create</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="tn">
          <Input id="tn" value={v.name} onChange={(e) => setV((x) => ({ ...x, name: e.target.value, slug: x.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) }))} />
        </Field>
        <Field label="Slug" htmlFor="ts">
          <Input id="ts" value={v.slug} onChange={(e) => setV((x) => ({ ...x, slug: e.target.value }))} />
        </Field>
        <Field label="Administrator email" htmlFor="ta">
          <Input id="ta" type="email" value={v.adminEmail} onChange={(e) => setV((x) => ({ ...x, adminEmail: e.target.value }))} />
        </Field>
        <Field label="Time zone" htmlFor="tz">
          <Input id="tz" value={v.timezone} onChange={(e) => setV((x) => ({ ...x, timezone: e.target.value }))} />
        </Field>
        <Field label="Plan" htmlFor="tp">
          <Select id="tp" value={v.planCode} onChange={(e) => setV((x) => ({ ...x, planCode: e.target.value }))}>
            {plans.data
              ?.filter((p) => p.active)
              .map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Billing period" htmlFor="tb">
          <Select id="tb" value={v.billingPeriod} onChange={(e) => setV((x) => ({ ...x, billingPeriod: e.target.value }))}>
            <option value="MONTHLY">Monthly</option>
            <option value="ANNUAL">Annual</option>
          </Select>
        </Field>
        <Field label="Trial days" htmlFor="tt" hint="0 starts an active subscription immediately">
          <Input id="tt" type="number" min={0} max={90} value={v.trialDays} onChange={(e) => setV((x) => ({ ...x, trialDays: Number(e.target.value) }))} />
        </Field>
      </div>
    </Dialog>
  );
}
