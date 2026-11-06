'use client';
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/**
 * Daily call attempts split into answered / unanswered (parts of a whole → stacked columns).
 * Palette: categorical slots 1–2 (validated: CVD ΔE 24.7, normal ΔE 33.6, ≥3:1 on #ffffff).
 * Marks: ≤24px columns, 4px rounded data-end, square baseline, 2px surface gap between segments.
 */
const SERIES = [
  { key: 'answered', label: 'Answered', color: '#2a78d6' },
  { key: 'unanswered', label: 'Not answered', color: '#eb6834' },
] as const;

export interface DayPoint {
  day: string;
  attempted: number;
  answered: number;
  unanswered: number;
  talkSeconds: number;
}

const GAP = 2;
const RADIUS = 4;

function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function segmentShape(series: 'answered' | 'unanswered') {
  // Recharts passes geometry plus the datum as `payload`.
  return function Segment(props: unknown) {
    const { x, y, width, height, payload } = props as { x: number; y: number; width: number; height: number; payload: DayPoint };
    if (!height || height <= 0) return <g />;
    const hasAbove = series === 'answered' && payload.unanswered > 0;
    const gap = hasAbove ? GAP : 0;
    const h = Math.max(0, height - gap);
    const r = hasAbove ? 0 : Math.min(RADIUS, width / 2, h);
    const color = SERIES.find((s) => s.key === series)!.color;
    return <path d={columnPath(x, y + gap, width, h, r)} fill={color} />;
  };
}

function shortDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: DayPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold text-ink">{shortDay(p.day)}</p>
      {SERIES.map((s) => (
        <p key={s.key} className="flex items-center gap-2 text-ink-2">
          <span className="size-2 rounded-sm" style={{ background: s.color }} aria-hidden />
          {s.label}
          <span className="ml-auto pl-3 tabular-nums text-ink">{p[s.key]}</span>
        </p>
      ))}
      <p className="mt-1 border-t border-line pt-1 text-muted">
        Attempts <span className="float-right pl-3 tabular-nums text-ink">{p.attempted}</span>
      </p>
    </div>
  );
}

export function CallsByDayChart({ data, height = 240 }: { data: DayPoint[]; height?: number }) {
  if (data.length === 0) return <p className="py-10 text-center text-sm text-muted">No call attempts in this period.</p>;
  return (
    <figure>
      <div className="mb-2 flex items-center gap-4 text-xs text-ink-2" aria-hidden>
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="#e2e5ea" strokeWidth={1} />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: '#667085', fontSize: 11 }} axisLine={{ stroke: '#e2e5ea' }} tickLine={false} minTickGap={12} />
            <YAxis allowDecimals={false} tick={{ fill: '#667085', fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f0f2f5' }} />
            <Bar dataKey="answered" stackId="calls" maxBarSize={24} shape={segmentShape('answered')} isAnimationActive={false} />
            <Bar dataKey="unanswered" stackId="calls" maxBarSize={24} shape={segmentShape('unanswered')} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">Call attempts per day, split into answered and not answered. The same data is available as a table.</figcaption>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted hover:text-ink">View as table</summary>
        <table className="mt-2 w-full">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 pr-3 font-medium">Day</th>
              <th className="py-1 pr-3 text-right font-medium">Attempts</th>
              <th className="py-1 pr-3 text-right font-medium">Answered</th>
              <th className="py-1 text-right font-medium">Not answered</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day} className="border-t border-line text-ink-2">
                <td className="py-1 pr-3">{shortDay(d.day)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{d.attempted}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{d.answered}</td>
                <td className="py-1 text-right tabular-nums">{d.unanswered}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Ranked magnitudes for one series (single hue, so no legend; values are text-token labels). */
export function RankedBars({ rows, valueLabel }: { rows: { label: string; value: number }[]; valueLabel?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted">Nothing recorded in this period.</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(7rem,9rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-ink-2">{r.label}</span>
          <span className="h-2.5 rounded-full bg-subtle">
            <span className="block h-2.5 rounded-full" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: '#2a78d6' }} />
          </span>
          <span className="tabular-nums text-ink">{valueLabel ? valueLabel(r.value) : r.value}</span>
        </li>
      ))}
    </ul>
  );
}
