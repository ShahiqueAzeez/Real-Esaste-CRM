'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatMoneyMinor, formatNumber } from '@/lib/format';

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPriceMinor: number;
  annualPriceMinor: number;
  currency: string;
  maxAgents: number;
  maxLeadImportsPerMonth: number;
  maxConcurrentCalls: number;
  features: { recording?: boolean; whatsapp?: boolean; coaching?: boolean; advancedReports?: boolean };
  active: boolean;
  sortOrder: number;
}

export default function PlansPage() {
  const q = useQuery({ queryKey: ['platform', 'plans'], queryFn: () => api.get<Plan[]>('/platform/plans') });
  const [editing, setEditing] = React.useState<Plan | 'new' | null>(null);
  return (
    <div>
      <PageHeader
        title="Plans"
        description="Software subscription plans and their limits. Prices are configurable examples; telephony and messaging are billed separately."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> New plan
          </Button>
        }
      />
      <Card>
        <DataTable
          caption="Plans"
          rows={q.data}
          loading={q.isLoading}
          onRowClick={(p) => setEditing(p)}
          columns={[
            { key: 'name', header: 'Plan', cell: (p) => <span className="font-medium text-ink">{p.name}</span> },
            { key: 'monthly', header: 'Monthly', className: 'text-right', cell: (p) => formatMoneyMinor(p.monthlyPriceMinor, p.currency) },
            { key: 'annual', header: 'Annual', className: 'text-right', cell: (p) => formatMoneyMinor(p.annualPriceMinor, p.currency) },
            { key: 'agents', header: 'Agents', className: 'text-right', cell: (p) => formatNumber(p.maxAgents) },
            { key: 'imports', header: 'Imports / month', className: 'text-right', cell: (p) => formatNumber(p.maxLeadImportsPerMonth) },
            { key: 'conc', header: 'Concurrent calls', className: 'text-right', cell: (p) => formatNumber(p.maxConcurrentCalls) },
            { key: 'features', header: 'Features', cell: (p) => <span className="space-x-1">{Object.entries(p.features).filter(([, on]) => on).map(([k]) => <Badge key={k}>{k}</Badge>)}</span> },
            { key: 'active', header: '', cell: (p) => (!p.active ? <Badge tone="warn">Inactive</Badge> : null) },
          ]}
        />
      </Card>
      {editing && <PlanDialog plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PlanDialog({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = React.useState({
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    monthly: plan ? String(plan.monthlyPriceMinor / 100) : '',
    annual: plan ? String(plan.annualPriceMinor / 100) : '',
    maxAgents: plan?.maxAgents ?? 5,
    maxLeadImportsPerMonth: plan?.maxLeadImportsPerMonth ?? 10000,
    maxConcurrentCalls: plan?.maxConcurrentCalls ?? 5,
    features: { recording: false, whatsapp: false, coaching: false, advancedReports: false, ...(plan?.features ?? {}) },
    active: plan?.active ?? true,
    sortOrder: plan?.sortOrder ?? 0,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { code: v.code, name: v.name, description: v.description || null, monthlyPriceMinor: Math.round(Number(v.monthly) * 100), annualPriceMinor: Math.round(Number(v.annual) * 100), currency: 'INR', maxAgents: v.maxAgents, maxLeadImportsPerMonth: v.maxLeadImportsPerMonth, maxConcurrentCalls: v.maxConcurrentCalls, features: v.features, active: v.active, sortOrder: v.sortOrder };
      return plan ? api.patch(`/platform/plans/${plan.id}`, body) : api.post('/platform/plans', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'plans'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const num = (k: 'maxAgents' | 'maxLeadImportsPerMonth' | 'maxConcurrentCalls' | 'sortOrder') => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: Number(e.target.value) }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={plan ? `Edit ${plan.name}` : 'New plan'} wide footer={<Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Code" htmlFor="pc">
          <Input id="pc" value={v.code} onChange={(e) => setV((x) => ({ ...x, code: e.target.value }))} />
        </Field>
        <Field label="Name" htmlFor="pn">
          <Input id="pn" value={v.name} onChange={(e) => setV((x) => ({ ...x, name: e.target.value }))} />
        </Field>
        <Field label="Order" htmlFor="po">
          <Input id="po" type="number" value={v.sortOrder} onChange={num('sortOrder')} />
        </Field>
        <Field label="Monthly price (₹)" htmlFor="pm">
          <Input id="pm" type="number" value={v.monthly} onChange={(e) => setV((x) => ({ ...x, monthly: e.target.value }))} />
        </Field>
        <Field label="Annual price (₹)" htmlFor="pa">
          <Input id="pa" type="number" value={v.annual} onChange={(e) => setV((x) => ({ ...x, annual: e.target.value }))} />
        </Field>
        <Field label="Max agents" htmlFor="pma">
          <Input id="pma" type="number" value={v.maxAgents} onChange={num('maxAgents')} />
        </Field>
        <Field label="Lead imports / month" htmlFor="pmi">
          <Input id="pmi" type="number" value={v.maxLeadImportsPerMonth} onChange={num('maxLeadImportsPerMonth')} />
        </Field>
        <Field label="Concurrent calls" htmlFor="pmc">
          <Input id="pmc" type="number" value={v.maxConcurrentCalls} onChange={num('maxConcurrentCalls')} />
        </Field>
        <Field label="Description" htmlFor="pd" className="sm:col-span-3">
          <Input id="pd" value={v.description} onChange={(e) => setV((x) => ({ ...x, description: e.target.value }))} />
        </Field>
        <div className="flex flex-wrap gap-4 sm:col-span-3">
          {(Object.keys(v.features) as (keyof typeof v.features)[]).map((k) => (
            <Checkbox key={k} label={k} checked={!!v.features[k]} onChange={(e) => setV((x) => ({ ...x, features: { ...x.features, [k]: e.target.checked } }))} />
          ))}
          <Checkbox label="Active" checked={v.active} onChange={(e) => setV((x) => ({ ...x, active: e.target.checked }))} />
        </div>
      </div>
    </Dialog>
  );
}
