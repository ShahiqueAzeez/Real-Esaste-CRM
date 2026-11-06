'use client';
import { passwordSchema } from '@crm/shared';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/feedback';
import { Field, Input } from '@/components/ui/form';
import { KeyValue, PageHeader } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';
import { usePermissions } from '@/lib/session';

export default function AccountPage() {
  const { me } = usePermissions();
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = passwordSchema.safeParse(next);
    if (!check.success) return setError(check.error.issues[0]?.message ?? 'Choose a stronger password');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      toast.success('Password changed. Other sessions were signed out.');
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!me) return null;
  return (
    <div className="max-w-2xl">
      <PageHeader title="Account" />
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <KeyValue
              items={[
                ['Name', me.user.name],
                ['Email', me.user.email],
                ['Email verified', me.user.emailVerified ? 'Yes' : 'No'],
                ['Organisation', me.membership?.tenant.name],
                ['Role', me.membership ? titleCase(me.membership.role) : me.user.isPlatformAdmin ? 'Platform administrator' : null],
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Change password</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={change} className="space-y-4">
              {error && <Alert tone="bad">{error}</Alert>}
              <Field label="Current password" htmlFor="cur">
                <Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </Field>
              <Field label="New password" htmlFor="new" hint="At least 10 characters, with letters and a number.">
                <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              </Field>
              <Button type="submit" loading={busy}>
                Change password
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
