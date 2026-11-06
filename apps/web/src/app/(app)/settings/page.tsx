'use client';
import { OUTCOME_CATEGORIES, RETRY_BEHAVIORS, type TenantSettings } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';
import { useOrgSettings, useSaveSettings } from '@/lib/settings';
import type { OutcomeDefinition } from '@/lib/types';

interface Org {
  tenant: { id: string; name: string; slug: string; timezone: string };
  subscription: { features: { recording: boolean; whatsapp: boolean; coaching: boolean } ; plan: { name: string } };
}

export default function SettingsPage() {
  const settings = useOrgSettings();
  const org = useQuery({ queryKey: ['org'], queryFn: () => api.get<Org>('/org') });
  if (!settings.data || !org.data) return <Skeleton className="h-96 w-full" />;
  return (
    <div>
      <PageHeader title="Settings" description="Organisation-wide behaviour. Compliance rules (hours, retries, consent) live on the Compliance page." />
      <div className="grid gap-4 xl:grid-cols-2">
        <OrgCard org={org.data} />
        <CallingCard s={settings.data} />
        <RecordingCard s={settings.data} allowed={org.data.subscription.features.recording} plan={org.data.subscription.plan.name} />
        <LeadsCard s={settings.data} />
        <WhatsAppCard s={settings.data} allowed={org.data.subscription.features.whatsapp} />
        <CostCard s={settings.data} />
        <OutcomesCard />
      </div>
    </div>
  );
}

function OrgCard({ org }: { org: Org }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(org.tenant.name);
  const [timezone, setTimezone] = React.useState(org.tenant.timezone);
  const save = useMutation({
    mutationFn: () => api.patch('/org', { name, timezone }),
    onSuccess: () => {
      toast.success('Organisation updated');
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organisation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label="Name" htmlFor="o-name">
          <Input id="o-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Time zone" htmlFor="o-tz" hint="IANA name. Calling hours and reports use it.">
          <Input id="o-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function CallingCard({ s }: { s: TenantSettings }) {
  const save = useSaveSettings();
  const [v, setV] = React.useState(s.calling);
  const [countries, setCountries] = React.useState(s.calling.allowedCountries.join(', '));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Calling</CardTitle>
          <CardDescription>Progressive dialling: one lead per agent, dialled after the agent’s line connects.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Default agent calling mode" htmlFor="c-mode">
          <Select id="c-mode" value={v.defaultMode} onChange={(e) => setV((x) => ({ ...x, defaultMode: e.target.value as 'BROWSER' | 'PHONE' }))}>
            <option value="BROWSER">Browser (WebRTC)</option>
            <option value="PHONE">Agent's phone</option>
          </Select>
        </Field>
        <Field label="Allowed destination countries" htmlFor="c-cc" hint="ISO codes, e.g. IN. Protects against toll fraud.">
          <Input id="c-cc" value={countries} onChange={(e) => setCountries(e.target.value)} />
        </Field>
        <Field label="Customer ring time (s)" htmlFor="c-crt">
          <Input id="c-crt" type="number" value={v.customerRingTimeoutSeconds} onChange={(e) => setV((x) => ({ ...x, customerRingTimeoutSeconds: Number(e.target.value) }))} />
        </Field>
        <Field label="Agent ring time (s)" htmlFor="c-art">
          <Input id="c-art" type="number" value={v.agentRingTimeoutSeconds} onChange={(e) => setV((x) => ({ ...x, agentRingTimeoutSeconds: Number(e.target.value) }))} />
        </Field>
        <Field label="Maximum call length (min)" htmlFor="c-max">
          <Input id="c-max" type="number" value={v.maxCallMinutes} onChange={(e) => setV((x) => ({ ...x, maxCallMinutes: Number(e.target.value) }))} />
        </Field>
        <Field label="Max calls per agent per hour" htmlFor="c-cph">
          <Input id="c-cph" type="number" value={v.maxCallsPerAgentPerHour} onChange={(e) => setV((x) => ({ ...x, maxCallsPerAgentPerHour: Number(e.target.value) }))} />
        </Field>
        <Checkbox className="sm:col-span-2" label="Record busy / no-answer / failed outcomes automatically" checked={v.autoWrapUpUnanswered} onChange={(e) => setV((x) => ({ ...x, autoWrapUpUnanswered: e.target.checked }))} />
        <div className="sm:col-span-2">
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ calling: { ...v, allowedCountries: countries.split(/[,\s]+/).filter(Boolean).map((c) => c.toUpperCase()) } })}>
            Save calling settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RecordingCard({ s, allowed, plan }: { s: TenantSettings; allowed: boolean; plan: string }) {
  const save = useSaveSettings();
  const [v, setV] = React.useState(s.recording);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Call recording</CardTitle>
          <CardDescription>Only where lawful and supported by the provider. Recordings are played through short-lived links and every access is logged.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!allowed && <Alert tone="info">Recording is not included in the {plan} plan.</Alert>}
        <Checkbox label="Record calls" checked={v.enabled} disabled={!allowed} onChange={(e) => setV((x) => ({ ...x, enabled: e.target.checked }))} />
        <Checkbox label="Play a recording notice to the customer" checked={v.playNotice} onChange={(e) => setV((x) => ({ ...x, playNotice: e.target.checked }))} />
        <Field label="Notice text" htmlFor="r-notice">
          <Textarea id="r-notice" value={v.noticeText} onChange={(e) => setV((x) => ({ ...x, noticeText: e.target.value }))} />
        </Field>
        <Field label="Keep recordings for (days)" htmlFor="r-ret" hint="Deleted from the provider after this period.">
          <Input id="r-ret" type="number" value={v.retentionDays} onChange={(e) => setV((x) => ({ ...x, retentionDays: Number(e.target.value) }))} />
        </Field>
        {v.enabled && !v.playNotice && <Alert tone="warn">Recording without informing the customer may be unlawful. Keep the notice on unless you have legal advice.</Alert>}
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ recording: v })}>
          Save recording settings
        </Button>
      </CardContent>
    </Card>
  );
}

function LeadsCard({ s }: { s: TenantSettings }) {
  const save = useSaveSettings();
  const [v, setV] = React.useState(s.leads);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Leads & retention</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Checkbox label="Assigned leads are dialled only by their agent" checked={v.strictOwnership} onChange={(e) => setV((x) => ({ ...x, strictOwnership: e.target.checked }))} />
        <Field label="Default country for local numbers" htmlFor="l-cc">
          <Input id="l-cc" value={v.defaultCountry} maxLength={2} onChange={(e) => setV((x) => ({ ...x, defaultCountry: e.target.value.toUpperCase() }))} />
        </Field>
        <Field label="Delete inactive leads after (days)" htmlFor="l-ret" hint="Leave empty to keep leads until deleted manually.">
          <Input id="l-ret" type="number" value={v.retentionDays ?? ''} onChange={(e) => setV((x) => ({ ...x, retentionDays: e.target.value ? Number(e.target.value) : null }))} />
        </Field>
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ leads: v })}>
          Save lead settings
        </Button>
      </CardContent>
    </Card>
  );
}

function WhatsAppCard({ s, allowed }: { s: TenantSettings; allowed: boolean }) {
  const save = useSaveSettings();
  const [v, setV] = React.useState(s.whatsapp);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>WhatsApp follow-ups</CardTitle>
          <CardDescription>Automated messages use approved utility templates only, respect opt-outs and consent, and are frequency-capped.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!allowed && <Alert tone="info">WhatsApp is not included in your plan.</Alert>}
        <Checkbox label="Send a confirmation when a callback is scheduled" checked={v.sendCallbackConfirmation} onChange={(e) => setV((x) => ({ ...x, sendCallbackConfirmation: e.target.checked }))} />
        <Checkbox label="Send a follow-up after a missed call" checked={v.sendMissedCallFollowup} onChange={(e) => setV((x) => ({ ...x, sendMissedCallFollowup: e.target.checked }))} />
        <Field label="Maximum messages per lead per 7 days" htmlFor="w-cap">
          <Input id="w-cap" type="number" value={v.maxMessagesPerLeadPer7Days} onChange={(e) => setV((x) => ({ ...x, maxMessagesPerLeadPer7Days: Number(e.target.value) }))} />
        </Field>
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ whatsapp: v })}>
          Save WhatsApp settings
        </Button>
      </CardContent>
    </Card>
  );
}

function CostCard({ s }: { s: TenantSettings }) {
  const save = useSaveSettings();
  const [v, setV] = React.useState(s.costEstimates);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Cost estimates</CardTitle>
          <CardDescription>Used only when the provider has not reported a cost. Always labelled as estimates; never an invoice.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <Field label="Currency" htmlFor="ce-cur">
          <Input id="ce-cur" maxLength={3} value={v.currency} onChange={(e) => setV((x) => ({ ...x, currency: e.target.value.toUpperCase() }))} />
        </Field>
        <Field label="Agent leg (paise/min)" htmlFor="ce-a">
          <Input id="ce-a" type="number" value={v.agentLegPerMinuteMinor ?? ''} onChange={(e) => setV((x) => ({ ...x, agentLegPerMinuteMinor: e.target.value === '' ? null : Number(e.target.value) }))} />
        </Field>
        <Field label="Customer leg (paise/min)" htmlFor="ce-c">
          <Input id="ce-c" type="number" value={v.customerLegPerMinuteMinor ?? ''} onChange={(e) => setV((x) => ({ ...x, customerLegPerMinuteMinor: e.target.value === '' ? null : Number(e.target.value) }))} />
        </Field>
        <div className="sm:col-span-3">
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ costEstimates: v })}>
            Save estimates
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OutcomesCard() {
  const outcomes = useQuery({ queryKey: ['org', 'outcomes'], queryFn: () => api.get<OutcomeDefinition[]>('/org/outcomes') });
  const [editing, setEditing] = React.useState<OutcomeDefinition | 'new' | null>(null);
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Call outcomes</CardTitle>
          <CardDescription>System outcomes drive retries and suppression; you can rename them or require notes. Add your own for reporting.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
          <Plus /> New outcome
        </Button>
      </CardHeader>
      <DataTable
        caption="Outcomes"
        rows={outcomes.data}
        loading={outcomes.isLoading}
        onRowClick={(o) => setEditing(o)}
        columns={[
          { key: 'label', header: 'Outcome', cell: (o) => <span className="font-medium text-ink">{o.label}</span> },
          { key: 'code', header: 'Code', cell: (o) => <span className="font-mono text-xs">{o.code}</span> },
          { key: 'cat', header: 'Category', cell: (o) => titleCase(o.category) },
          { key: 'next', header: 'Then', cell: (o) => (o.suppressReason ? 'Add to do-not-call' : o.isFinal ? 'Stop dialling' : titleCase(o.retryBehavior)) },
          { key: 'req', header: 'Requires', cell: (o) => [o.requiresNotes && 'notes', o.requiresCallback && 'callback time'].filter(Boolean).join(', ') || '—' },
          { key: 'flags', header: '', cell: (o) => <span className="space-x-1">{o.isSystem && <Badge>System</Badge>}{!o.active && <Badge tone="warn">Inactive</Badge>}{!o.selectable && <Badge>Automatic</Badge>}</span> },
        ]}
      />
      {editing && <OutcomeDialog outcome={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function OutcomeDialog({ outcome, onClose }: { outcome: OutcomeDefinition | null; onClose: () => void }) {
  const qc = useQueryClient();
  const system = !!outcome?.isSystem;
  const [v, setV] = React.useState({
    code: outcome?.code ?? '',
    label: outcome?.label ?? '',
    category: outcome?.category ?? 'NEUTRAL',
    retryBehavior: outcome?.retryBehavior ?? 'NONE',
    requiresNotes: outcome?.requiresNotes ?? false,
    requiresCallback: outcome?.requiresCallback ?? false,
    isFinal: outcome?.isFinal ?? false,
    active: outcome?.active ?? true,
    sortOrder: outcome?.sortOrder ?? 500,
  });
  const save = useMutation({
    mutationFn: () => {
      const { code, ...rest } = v;
      return outcome ? api.patch(`/org/outcomes/${outcome.id}`, rest) : api.post('/org/outcomes', { ...rest, code });
    },
    onSuccess: () => {
      toast.success('Outcome saved');
      void qc.invalidateQueries({ queryKey: ['org', 'outcomes'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={outcome ? `Edit “${outcome.label}”` : 'New outcome'} description={system ? 'System outcome: only the label, notes requirement and order can change.' : undefined} footer={<Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {!outcome && (
          <Field label="Code" htmlFor="oc-code" hint="UPPER_SNAKE_CASE, permanent">
            <Input id="oc-code" value={v.code} onChange={(e) => setV((x) => ({ ...x, code: e.target.value.toUpperCase() }))} />
          </Field>
        )}
        <Field label="Label" htmlFor="oc-label">
          <Input id="oc-label" value={v.label} onChange={(e) => setV((x) => ({ ...x, label: e.target.value }))} />
        </Field>
        <Field label="Category" htmlFor="oc-cat">
          <Select id="oc-cat" value={v.category} disabled={system} onChange={(e) => setV((x) => ({ ...x, category: e.target.value }))}>
            {OUTCOME_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What happens next" htmlFor="oc-next">
          <Select id="oc-next" value={v.retryBehavior} disabled={system} onChange={(e) => setV((x) => ({ ...x, retryBehavior: e.target.value, requiresCallback: e.target.value === 'CALLBACK' ? true : x.requiresCallback }))}>
            {RETRY_BEHAVIORS.map((c) => (
              <option key={c} value={c}>
                {c === 'NONE' ? 'Nothing (remove from queue)' : c === 'RETRY' ? 'Retry per policy' : 'Schedule a callback'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Order" htmlFor="oc-order">
          <Input id="oc-order" type="number" value={v.sortOrder} onChange={(e) => setV((x) => ({ ...x, sortOrder: Number(e.target.value) }))} />
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <Checkbox label="Requires notes" checked={v.requiresNotes} onChange={(e) => setV((x) => ({ ...x, requiresNotes: e.target.checked }))} />
          {!system && <Checkbox label="Requires a callback time" checked={v.requiresCallback} onChange={(e) => setV((x) => ({ ...x, requiresCallback: e.target.checked }))} />}
          {!system && <Checkbox label="Closes the lead (no more calls)" checked={v.isFinal} onChange={(e) => setV((x) => ({ ...x, isFinal: e.target.checked }))} />}
          {!system && <Checkbox label="Active" checked={v.active} onChange={(e) => setV((x) => ({ ...x, active: e.target.checked }))} />}
        </div>
      </div>
    </Dialog>
  );
}
