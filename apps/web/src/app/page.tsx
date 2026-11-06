'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Spinner } from '@/components/ui/feedback';
import { homePath, useMe } from '@/lib/session';

export default function Home() {
  const { data, isLoading } = useMe();
  const router = useRouter();
  React.useEffect(() => {
    if (!isLoading) router.replace(homePath(data));
  }, [data, isLoading, router]);
  return (
    <main className="grid min-h-screen place-items-center">
      <Spinner />
    </main>
  );
}
