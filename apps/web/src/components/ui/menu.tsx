'use client';
import { DropdownMenu as M } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export function MenuContent({ className, ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content sideOffset={6} align="end" className={cn('z-50 min-w-48 rounded-lg border border-line bg-surface p-1 shadow-lg', className)} {...props} />
    </M.Portal>
  );
}
export function MenuItem({ className, ...props }: React.ComponentProps<typeof M.Item>) {
  return <M.Item className={cn('flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-ink-2 outline-none data-[highlighted]:bg-subtle data-[highlighted]:text-ink [&_svg]:size-4', className)} {...props} />;
}
export function MenuLabel({ className, ...props }: React.ComponentProps<typeof M.Label>) {
  return <M.Label className={cn('px-2.5 py-1.5 text-xs text-muted', className)} {...props} />;
}
export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-line" />;
