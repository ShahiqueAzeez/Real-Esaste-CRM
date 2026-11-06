'use client';
import { Tabs as T } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn('inline-flex gap-1 rounded-lg border border-line bg-subtle p-1', className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return <T.Trigger className={cn('rounded-md px-3 py-1.5 text-sm font-medium text-muted data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm', className)} {...props} />;
}
export function TabsContent({ className, ...props }: React.ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('mt-4', className)} {...props} />;
}
