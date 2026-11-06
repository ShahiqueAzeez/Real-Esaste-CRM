'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Alert, Spinner } from '@/components/ui/feedback';
import { api, errorMessage } from '@/lib/api';

export default function VerifyEmailPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = React.useState<{ status: 'busy' | 'ok' | 'error'; message?: string }>({ status: 'busy' });
  React.useEffect(() => {
    api
      .post(`/auth/verify-email/confirm/${token}`)
      .then(() => setState({ status: 'ok' }))
      .catch((err) => setState({ status: 'error', message: errorMessage(err) }));
  }, [token]);
  if (state.status === 'busy') return <Spinner />;
  return (
    <div className="space-y-4">
      {state.status === 'ok' ? <Alert tone="ok" title="Email verified" /> : <Alert tone="bad" title="Verification failed">{state.message}</Alert>}
      <Link href="/" className="text-sm text-brand hover:underline">
        Continue
      </Link>
    </div>
  );
}
