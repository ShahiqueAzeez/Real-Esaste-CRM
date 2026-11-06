import * as React from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad' | 'info' | 'sim';

const tones: Record<Tone, string> = {
  neutral: 'bg-subtle text-ink-2 border-line',
  brand: 'bg-brand-soft text-brand border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  sim: 'bg-sim-soft text-sim border-transparent',
};

export function Badge({ tone = 'neutral', className, dot, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)} {...props}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {props.children}
    </span>
  );
}

/** Marks anything produced by the simulated provider. Never omit it on simulated data. */
export function SimulatedBadge({ className }: { className?: string }) {
  return (
    <Badge tone="sim" className={className} title="Simulated: no real phone call or message was made">
      SIMULATED
    </Badge>
  );
}
