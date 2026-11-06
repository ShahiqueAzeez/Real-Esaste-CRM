'use client';
import Link from 'next/link';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('busy');
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email });
      setState('sent');
    } catch (err) {
      setError(errorMessage(err));
      setState('idle');
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Reset your password</h1>
        <p className="mt-1 text-sm text-muted">We will email a reset link if the account exists.</p>
      </div>
      {state === 'sent' ? (
        <Alert tone="ok" title="Check your email">
          If an account exists for {email}, a link valid for 60 minutes is on its way. If your organisation has not set up email, ask an administrator for a reset link.
        </Alert>
      ) : (
        <>
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Button type="submit" className="w-full" loading={state === 'busy'}>
            Send reset link
          </Button>
        </>
      )}
      <p className="text-center text-sm">
        <Link href="/login" className="text-brand hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
