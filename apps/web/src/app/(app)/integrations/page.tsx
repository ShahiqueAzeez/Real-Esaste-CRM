'use client';
import { WA_PURPOSES } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Badge, SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { usePermissions } from '@/lib/session';

interface Status {
  telephony: {
    active: 'PLIVO' | 'MOCK' | null;
    source: string;
    simulated: boolean;
    plivo: null | { enabled: boolean; status: string; authIdMasked: string | null; callerIds: string[]; defaultCallerId: string | null; costCurrency: string; lastError: string | null; lastCheckedAt: string | null };
    webhookBase: string;
    browserSipUriTemplate: string;
  };
  whatsapp: { configured: boolean; simulated: boolean; webhookUrl: string; phoneNumberId: string | null; graphApiVersion: string | null; hasAppSecret: boolean; hasVerifyToken: boolean; lastError: string | null };
  email: { configured: boolean };
  storage: { driver: string };
}

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <Field label={label} htmlFor={label}>
      <div className="flex gap-2">
        <Input id={label} readOnly value={value} className="font-mono text-xs" />
        <Button
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success('Copied');
          }}
        >
          <Copy />
        </Button>
      </div>
    </Field>
  );
}

export default function IntegrationsPage() {
  const status = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<Status>('/integrations') });
  if (!status.data) return <Skeleton className="h-96 w-full" />;
  const s = status.data;
  return (
    <div>
      <PageHeader title="Integrations" description="Credentials are encrypted at rest and never shown again after saving." />
      <div className="grid gap-4 xl:grid-cols-2">
        <PlivoCard s={s} />
        <Card>
          <CardHeader>
            <div>
              <CardTitle>India calling checklist</CardTitle>
              <CardDescription>Confirm each item with Plivo and your legal adviser before calling customers.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-ink-2">
              {[
                'Plivo account created in the India data region (cannot be changed later) with KYC approved (GST, COI or Udyam).',
                'Caller ID is a number rented on your Plivo account; promotional calls use 140-series numbers.',
                'DLT registration completed as required by your operator; scrub against the DND/NCPR registry.',
                'Both call legs must stay in India (media anchoring, hangup cause 4590). Confirm browser (WebRTC) calling is supported for your account, or switch agents to phone mode.',
                'Enable HTTP authentication on recording URLs in the Plivo console (recordings are public by default).',
                'Run the smoke test in docs/TELEPHONY_PLIVO.md with approved test numbers.',
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted" />
                  {t}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <WhatsAppCard s={s} />
        <Card>
          <CardHeader>
            <CardTitle>Email & storage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span>Transactional email</span>
              <StatusBadge value={s.email.configured ? 'CONFIGURED' : 'NOT_CONFIGURED'} />
            </div>
            {!s.email.configured && <Alert tone="info">Email is not configured by the platform. Invitations and password resets show a link to copy and share instead.</Alert>}
            <div className="flex items-center justify-between">
              <span>File storage</span>
              <Badge>{s.storage.driver === 's3' ? 'S3-compatible' : 'Local disk'}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PlivoCard({ s }: { s: Status }) {
  const qc = useQueryClient();
  const p = s.telephony.plivo;
  const [v, setV] = React.useState({ enabled: p?.enabled ?? true, authId: '', authToken: '', callerIds: (p?.callerIds ?? []).join('\n'), defaultCallerId: p?.defaultCallerId ?? '' });
  const save = useMutation({
    mutationFn: () => {
      const callerIds = v.callerIds.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      return api.put('/integrations/plivo', { enabled: v.enabled, authId: v.authId, authToken: v.authToken || undefined, callerIds, defaultCallerId: v.defaultCallerId || callerIds[0] });
    },
    onSuccess: () => {
      toast.success('Plivo settings saved');
      setV((x) => ({ ...x, authToken: '' }));
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      void qc.invalidateQueries({ queryKey: ['telephony'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/integrations/plivo/test'),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete('/integrations/plivo'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      void qc.invalidateQueries({ queryKey: ['telephony'] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            Plivo voice {s.telephony.simulated && <SimulatedBadge />}
          </CardTitle>
          <CardDescription>
            Active provider: {s.telephony.active === 'PLIVO' ? `Plivo (${s.telephony.source === 'tenant' ? 'your account' : 'platform account'})` : s.telephony.active === 'MOCK' ? 'Simulator (no real calls)' : 'none'}
          </CardDescription>
        </div>
        {p && <StatusBadge value={p.status} />}
      </CardHeader>
      <CardContent className="space-y-4">
        {p?.lastError && <Alert tone="bad" title="Last error">{p.lastError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Auth ID" htmlFor="pl-id" hint={p?.authIdMasked ? `Saved: ${p.authIdMasked}` : undefined}>
            <Input id="pl-id" value={v.authId} onChange={(e) => setV((x) => ({ ...x, authId: e.target.value.trim() }))} placeholder="MAXXXXXXXXXXXXXXXXXX" autoComplete="off" />
          </Field>
          <Field label="Auth token" htmlFor="pl-token" hint={p ? 'Leave empty to keep the saved token' : undefined}>
            <Input id="pl-token" type="password" value={v.authToken} onChange={(e) => setV((x) => ({ ...x, authToken: e.target.value }))} autoComplete="new-password" />
          </Field>
          <Field label="Caller IDs (one per line)" htmlFor="pl-cids" hint="Numbers rented on this Plivo account, in +91… format">
            <textarea id="pl-cids" className="min-h-20 w-full rounded-md border border-line-strong px-3 py-2 font-mono text-sm" value={v.callerIds} onChange={(e) => setV((x) => ({ ...x, callerIds: e.target.value }))} />
          </Field>
          <Field label="Default caller ID" htmlFor="pl-def">
            <Input id="pl-def" value={v.defaultCallerId} onChange={(e) => setV((x) => ({ ...x, defaultCallerId: e.target.value }))} placeholder="+914412345678" />
          </Field>
        </div>
        <Checkbox label="Use this Plivo account for calls" checked={v.enabled} onChange={(e) => setV((x) => ({ ...x, enabled: e.target.checked }))} />
        <div className="flex flex-wrap gap-2">
          <Button loading={save.isPending} disabled={!v.authId} onClick={() => save.mutate()}>
            Save
          </Button>
          {p && (
            <Button variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
              Test connection
            </Button>
          )}
          {p && (
            <Button variant="ghost" onClick={() => remove.mutate()}>
              Remove
            </Button>
          )}
        </div>
        {p?.lastCheckedAt && <p className="text-xs text-muted">Last checked {formatDateTime(p.lastCheckedAt)}. The test reads your account details; it places no call.</p>}
        <CopyField label="Webhook base (set automatically per call)" value={s.telephony.webhookBase} />
      </CardContent>
    </Card>
  );
}

function WhatsAppCard({ s }: { s: Status }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const w = s.whatsapp;
  const [v, setV] = React.useState({ enabled: true, phoneNumberId: w.phoneNumberId ?? '', businessAccountId: '', graphApiVersion: w.graphApiVersion ?? 'v23.0', accessToken: '', appSecret: '', webhookVerifyToken: '' });
  const templates = useQuery({ queryKey: ['whatsapp', 'templates'], queryFn: () => api.get<{ id: string; name: string; language: string; purpose: string; category: string; variables: string[]; active: boolean }[]>('/whatsapp/templates') });
  const [newTemplate, setNewTemplate] = React.useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.put('/whatsapp/config', {
        ...v,
        businessAccountId: v.businessAccountId || null,
        accessToken: v.accessToken || undefined,
        appSecret: v.appSecret || undefined,
        webhookVerifyToken: v.webhookVerifyToken || undefined,
      }),
    onSuccess: () => {
      toast.success('WhatsApp settings saved');
      setV((x) => ({ ...x, accessToken: '', appSecret: '', webhookVerifyToken: '' }));
      void qc.invalidateQueries({ queryKey: ['integrations'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">WhatsApp Business (Cloud API) {w.simulated && <SimulatedBadge />}</CardTitle>
          <CardDescription>Optional. Without credentials the rest of the CRM works normally; messages are recorded as simulated in development only.</CardDescription>
        </div>
        <StatusBadge value={w.configured ? 'CONFIGURED' : 'NOT_CONFIGURED'} />
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          {w.lastError && <Alert tone="bad" title="Last error">{w.lastError}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone number ID" htmlFor="wa-pn">
              <Input id="wa-pn" value={v.phoneNumberId} onChange={(e) => setV((x) => ({ ...x, phoneNumberId: e.target.value }))} />
            </Field>
            <Field label="Graph API version" htmlFor="wa-ver">
              <Input id="wa-ver" value={v.graphApiVersion} onChange={(e) => setV((x) => ({ ...x, graphApiVersion: e.target.value }))} />
            </Field>
            <Field label="Access token" htmlFor="wa-token" hint="System-user permanent token">
              <Input id="wa-token" type="password" autoComplete="new-password" value={v.accessToken} onChange={(e) => setV((x) => ({ ...x, accessToken: e.target.value }))} />
            </Field>
            <Field label="App secret" htmlFor="wa-secret" hint={w.hasAppSecret ? 'Saved. Leave empty to keep.' : 'Used to verify webhook signatures'}>
              <Input id="wa-secret" type="password" autoComplete="new-password" value={v.appSecret} onChange={(e) => setV((x) => ({ ...x, appSecret: e.target.value }))} />
            </Field>
            <Field label="Webhook verify token" htmlFor="wa-verify" hint={w.hasVerifyToken ? 'Saved. Leave empty to keep.' : 'Any long random string; paste the same in Meta'}>
              <Input id="wa-verify" type="password" autoComplete="new-password" value={v.webhookVerifyToken} onChange={(e) => setV((x) => ({ ...x, webhookVerifyToken: e.target.value }))} />
            </Field>
          </div>
          <Button loading={save.isPending} disabled={!v.phoneNumberId} onClick={() => save.mutate()}>
            Save WhatsApp settings
          </Button>
          <CopyField label="Webhook URL (paste into Meta)" value={w.webhookUrl} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-ink">Approved templates</p>
            {can('org:integrations:manage') && (
              <Button size="sm" variant="outline" onClick={() => setNewTemplate(true)}>
                <Plus /> Add template
              </Button>
            )}
          </div>
          <DataTable
            caption="WhatsApp templates"
            rows={templates.data}
            loading={templates.isLoading}
            columns={[
              { key: 'name', header: 'Name', cell: (t) => <span className="font-mono text-xs">{t.name}</span> },
              { key: 'purpose', header: 'Used for', cell: (t) => titleCase(t.purpose) },
              { key: 'cat', header: 'Category', cell: (t) => <Badge tone={t.category === 'UTILITY' ? 'ok' : 'warn'}>{titleCase(t.category)}</Badge> },
              { key: 'vars', header: 'Variables', cell: (t) => <span className="text-xs">{t.variables.join(', ') || '—'}</span> },
            ]}
          />
          <p className="mt-2 text-xs text-muted">Register templates here exactly as approved in WhatsApp Manager (name and language). Automated follow-ups only use UTILITY templates.</p>
        </div>
      </CardContent>
      {newTemplate && <TemplateDialog onClose={() => setNewTemplate(false)} />}
    </Card>
  );
}

function TemplateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const VARS = ['lead.fullName', 'lead.firstName', 'callback.when', 'org.name', 'agent.name'];
  const [v, setV] = React.useState({ name: '', language: 'en', purpose: 'MANUAL', category: 'UTILITY', variables: [] as string[] });
  const save = useMutation({
    mutationFn: () => api.post('/whatsapp/templates', v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['whatsapp', 'templates'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Register an approved template" footer={<Button loading={save.isPending} disabled={!v.name} onClick={() => save.mutate()}>Save</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Template name" htmlFor="t-n">
          <Input id="t-n" value={v.name} onChange={(e) => setV((x) => ({ ...x, name: e.target.value }))} placeholder="callback_confirmation" />
        </Field>
        <Field label="Language code" htmlFor="t-l">
          <Input id="t-l" value={v.language} onChange={(e) => setV((x) => ({ ...x, language: e.target.value }))} />
        </Field>
        <Field label="Used for" htmlFor="t-p">
          <Select id="t-p" value={v.purpose} onChange={(e) => setV((x) => ({ ...x, purpose: e.target.value }))}>
            {WA_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {titleCase(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category" htmlFor="t-c">
          <Select id="t-c" value={v.category} onChange={(e) => setV((x) => ({ ...x, category: e.target.value }))}>
            <option value="UTILITY">Utility</option>
            <option value="MARKETING">Marketing</option>
          </Select>
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium text-ink">Body variables, in order ({'{{1}}'}, {'{{2}}'}, …)</legend>
          <div className="flex flex-wrap gap-2">
            {VARS.map((x) => (
              <Checkbox key={x} label={x} checked={v.variables.includes(x)} onChange={(e) => setV((s) => ({ ...s, variables: e.target.checked ? [...s.variables, x] : s.variables.filter((y) => y !== x) }))} />
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
