'use client';
import * as React from 'react';
import { Input, Select } from './ui/form';

export interface Range {
  from: string;
  to: string;
}

const DAY = 86400_000;
function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function presetRange(preset: string): Range {
  const today = startOfDay(new Date());
  const tomorrow = new Date(today.getTime() + DAY);
  const days = preset === 'today' ? 1 : preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return { from: new Date(tomorrow.getTime() - days * DAY).toISOString(), to: tomorrow.toISOString() };
}

/** Date-range control: presets plus custom dates (local days). One row, above the charts. */
export function DateRangeControl({ value, onChange }: { value: Range & { preset: string }; onChange: (v: Range & { preset: string }) => void }) {
  const toDateInput = (iso: string) => new Date(iso).toLocaleDateString('en-CA');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Period" className="w-40" value={value.preset} onChange={(e) => (e.target.value === 'custom' ? onChange({ ...value, preset: 'custom' }) : onChange({ ...presetRange(e.target.value), preset: e.target.value }))}>
        <option value="today">Today</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="90d">Last 90 days</option>
        <option value="custom">Custom…</option>
      </Select>
      {value.preset === 'custom' && (
        <>
          <Input aria-label="From" type="date" className="w-40" value={toDateInput(value.from)} onChange={(e) => e.target.value && onChange({ ...value, from: startOfDay(new Date(`${e.target.value}T00:00:00`)).toISOString() })} />
          <Input aria-label="To" type="date" className="w-40" value={toDateInput(new Date(Date.parse(value.to) - 1).toISOString())} onChange={(e) => e.target.value && onChange({ ...value, to: new Date(startOfDay(new Date(`${e.target.value}T00:00:00`)).getTime() + DAY).toISOString() })} />
        </>
      )}
    </div>
  );
}
