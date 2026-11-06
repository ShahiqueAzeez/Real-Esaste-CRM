'use client';
import { passwordSchema } from '@crm/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';

export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = passwordSchema.safeParse(password);
    if (!check.success) return setError(check.error.issues[0]?.message ?? 'Choose a stronger password');
    if (password !== confirm) return setError('The passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <div className="space-y-4">
        <Alert tone="ok" title="Password updated">
          All other sessions were signed out.
        </Alert>
        <Button asChild className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      {error && <Alert tone="bad">{error}</Alert>}
      <Field label="New password" htmlFor="pw" hint="At least 10 characters, with letters and a number.">
        <Input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Confirm password" htmlFor="pw2">
        <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <Button type="submit" className="w-full" loading={busy}>
        Update password
      </Button>
    </form>
  );
}
