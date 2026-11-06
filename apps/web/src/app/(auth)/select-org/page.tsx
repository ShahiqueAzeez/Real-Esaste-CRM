'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/feedback';
import { api, errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';
import { homePath, meKey, useMe, useSignOut } from '@/lib/session';
import type { Me } from '@/lib/types';

export default function SelectOrgPage() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const signOut = useSignOut();
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLoading && !me) router.replace('/login');
  }, [isLoading, me, router]);
  if (!me) return <Spinner />;

  const choose = async (membershipId: string) => {
    setBusy(membershipId);
    try {
      const next = await api.post<Me>('/auth/select-membership', { membershipId });
      qc.clear();
      qc.setQueryData(meKey, next);
      router.replace(homePath(next));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Choose an organisation</h1>
        <p className="mt-1 text-sm text-muted">Signed in as {me.user.email}</p>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {me.memberships.map((m) => (
          <li key={m.id}>
            <button type="button" disabled={m.tenantStatus !== 'ACTIVE' || !!busy} onClick={() => choose(m.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle disabled:opacity-50">
              <Building2 className="size-4 text-muted" />
              <span className="flex-1">
                <span className="block font-medium text-ink">{m.tenantName}</span>
                <span className="text-xs text-muted">{m.tenantStatus === 'ACTIVE' ? titleCase(m.role) : 'Suspended'}</span>
              </span>
              {busy === m.id ? <Spinner /> : <ChevronRight className="size-4 text-muted" />}
            </button>
          </li>
        ))}
      </ul>
      {me.user.isPlatformAdmin && (
        <Button variant="outline" className="w-full" onClick={() => router.push('/platform')}>
          Open platform administration
        </Button>
      )}
      <Button variant="ghost" className="w-full" onClick={signOut}>
        Sign out
      </Button>
    </div>
  );
}
