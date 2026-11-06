'use client';
import { passwordSchema } from '@crm/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';
import { homePath, meKey } from '@/lib/session';
import type { Me } from '@/lib/types';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api.get<{ email: string; role: string; organization: string; accountExists: boolean }>(`/auth/invitations/${token}`), retry: false });
  const [name, setName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (invite.isLoading) return <Spinner />;
  if (invite.error) return <Alert tone="bad" title="Invitation unavailable">{errorMessage(invite.error)}</Alert>;
  const inv = invite.data!;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!inv.accountExists) {
      const check = passwordSchema.safeParse(password);
      if (!check.success) return setError(check.error.issues[0]?.message ?? 'Choose a stronger password');
      if (!name.trim()) return setError('Enter your name');
    }
    setBusy(true);
    try {
      const me = await api.post<Me>('/auth/invitations/accept', { token, name: name.trim() || 'Member', password });
      qc.setQueryData(meKey, me);
      router.replace(homePath(me));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Join {inv.organization}</h1>
        <p className="mt-1 text-sm text-muted">
          You were invited as <strong>{titleCase(inv.role)}</strong> with {inv.email}.
        </p>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {!inv.accountExists && (
        <Field label="Your name" htmlFor="name" required>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
        </Field>
      )}
      <Field
        label={inv.accountExists ? 'Your current password' : 'Choose a password'}
        htmlFor="password"
        required
        hint={inv.accountExists ? 'This email already has an account. Confirm it is you.' : 'At least 10 characters, with letters and a number.'}
      >
        <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={inv.accountExists ? 'current-password' : 'new-password'} />
      </Field>
      <Button type="submit" className="w-full" loading={busy}>
        Accept invitation
      </Button>
    </form>
  );
}
