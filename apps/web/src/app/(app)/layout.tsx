'use client';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { AppShell } from '@/components/shell';
import { Spinner } from '@/components/ui/feedback';
import { RealtimeProvider } from '@/lib/realtime';
import { useMe } from '@/lib/session';

/** Every page below requires a session. The API enforces permissions; this only routes users. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading } = useMe();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (isLoading) return;
    if (!me) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (!me.membership && !pathname.startsWith('/platform') && pathname !== '/account') {
      router.replace(me.user.isPlatformAdmin ? '/platform' : '/select-org');
    }
  }, [isLoading, me, pathname, router]);

  if (isLoading || !me) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  return (
    <RealtimeProvider enabled={!!me.membership}>
      <AppShell>{children}</AppShell>
    </RealtimeProvider>
  );
}
