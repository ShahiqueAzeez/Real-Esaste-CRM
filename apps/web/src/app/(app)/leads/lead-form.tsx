'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { CONSENT_STATUSES, LEAD_PRIORITIES, leadCreateSchema } from '@crm/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { api, ApiError, errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';
import { useAgents, useQueues } from '@/lib/hooks';
import type { Lead } from '@/lib/types';

type Values = z.input<typeof leadCreateSchema>;

export function NewLeadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const agents = useAgents();
  const queues = useQueues();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(leadCreateSchema), defaultValues: { priority: 'NORMAL', consentStatus: 'UNKNOWN' } });
  const { register, handleSubmit, formState, watch, setError, reset } = form;
  const consent = watch('consentStatus');
  const create = useMutation({
    mutationFn: (values: Values) => api.post<Lead>('/leads', values),
    onSuccess: (lead) => {
      toast.success('Lead created');
      void qc.invalidateQueries({ queryKey: ['leads'] });
      reset();
      onOpenChange(false);
      router.push(`/leads/${lead.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError) for (const [k, m] of Object.entries(err.fieldErrors())) setError(k as keyof Values, { message: m });
      setServerError(err instanceof ApiError && err.code === 'DUPLICATE_LEAD' ? 'A lead with this phone number already exists.' : errorMessage(err));
    },
  });
  const e = formState.errors;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New lead"
      description="Phone numbers are normalised to international format. Only record consent you can evidence."
      wide
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button form="new-lead" type="submit" loading={create.isPending}>
            Create lead
          </Button>
        </>
      }
    >
      <form id="new-lead" className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit((v) => { setServerError(null); create.mutate(v); })} noValidate>
        {serverError && <Alert tone="bad" className="sm:col-span-2">{serverError}</Alert>}
        <Field label="Full name" htmlFor="fullName" required error={e.fullName?.message}>
          <Input id="fullName" {...register('fullName')} aria-invalid={!!e.fullName} />
        </Field>
        <Field label="Phone" htmlFor="phone" required error={e.phone?.message} hint="e.g. 98400 12345 or +91 98400 12345">
          <Input id="phone" inputMode="tel" {...register('phone')} aria-invalid={!!e.phone} />
        </Field>
        <Field label="Email" htmlFor="email" error={e.email?.message}>
          <Input id="email" type="email" {...register('email')} />
        </Field>
        <Field label="Source" htmlFor="source" hint="Campaign, portal or referral">
          <Input id="source" {...register('source')} />
        </Field>
        <Field label="Property interest" htmlFor="propertyInterest">
          <Input id="propertyInterest" placeholder="3 BHK apartment" {...register('propertyInterest')} />
        </Field>
        <Field label="Preferred location" htmlFor="preferredLocation">
          <Input id="preferredLocation" placeholder="Velachery" {...register('preferredLocation')} />
        </Field>
        <Field label="Budget from (₹)" htmlFor="budgetMin" error={e.budgetMin?.message}>
          <Input id="budgetMin" type="number" min={0} step={100000} {...register('budgetMin')} />
        </Field>
        <Field label="Budget to (₹)" htmlFor="budgetMax" error={e.budgetMax?.message}>
          <Input id="budgetMax" type="number" min={0} step={100000} {...register('budgetMax')} />
        </Field>
        <Field label="Priority" htmlFor="priority">
          <Select id="priority" {...register('priority')}>
            {LEAD_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {titleCase(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned agent" htmlFor="assigned" hint="Assigned leads are dialled only by that agent">
          <Select id="assigned" {...register('assignedMembershipId', { setValueAs: (v) => v || null })}>
            <option value="">Unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.user.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Queue" htmlFor="queue">
          <Select id="queue" {...register('queueId', { setValueAs: (v) => v || null })}>
            <option value="">Default queue</option>
            {queues.data?.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Contact permission" htmlFor="consentStatus" hint="Leads without recorded consent are not dialled when consent is required.">
          <Select id="consentStatus" {...register('consentStatus')}>
            {CONSENT_STATUSES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </Select>
        </Field>
        {consent === 'GRANTED' && (
          <>
            <Field label="Consent source" htmlFor="consentSource" required error={e.consentSource?.message}>
              <Input id="consentSource" placeholder="Website enquiry form, 12 Oct" {...register('consentSource')} />
            </Field>
            <Field label="Evidence" htmlFor="consentEvidence" hint="Form ID, recording reference or URL">
              <Input id="consentEvidence" {...register('consentEvidence')} />
            </Field>
          </>
        )}
        <Field label="Note" htmlFor="note" className="sm:col-span-2">
          <Textarea id="note" {...register('note')} />
        </Field>
      </form>
    </Dialog>
  );
}
