/** Display helpers. Timestamps arrive in UTC and are shown in the organization's time zone. */
export function formatDateTime(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
}

export function formatDate(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone }).format(new Date(value));
}

export function formatTime(value: string | Date | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone }).format(new Date(value));
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** 3725 → "1h 2m", 95 → "1m 35s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function formatNumber(n: number | null | undefined): string {
  return n == null ? '—' : new Intl.NumberFormat('en-IN').format(n);
}

export function formatPercent(ratio: number | null | undefined): string {
  return ratio == null ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

/** Minor units (paise) → "₹14,999.00". */
export function formatMoneyMinor(minor: number | null | undefined, currency = 'INR'): string {
  if (minor == null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);
}

/** Provider costs are micro-units (1/1,000,000). */
export function formatMoneyMicros(micros: number | null | undefined, currency: string | null | undefined): string {
  if (micros == null) return '—';
  const value = micros / 1_000_000;
  if (!currency) return value.toFixed(4);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 4 }).format(value);
}

/** Property budgets in rupees: 7500000 → "₹75 L", 12000000 → "₹1.2 Cr". */
export function formatBudget(rupees: number | null | undefined): string {
  if (rupees == null) return '—';
  if (rupees >= 1e7) return `₹${+(rupees / 1e7).toFixed(2)} Cr`;
  if (rupees >= 1e5) return `₹${+(rupees / 1e5).toFixed(1)} L`;
  return `₹${new Intl.NumberFormat('en-IN').format(rupees)}`;
}

export function formatBudgetRange(min: number | null | undefined, max: number | null | undefined): string {
  if (min == null && max == null) return '—';
  if (min != null && max != null) return `${formatBudget(min)} – ${formatBudget(max)}`;
  return min != null ? `from ${formatBudget(min)}` : `up to ${formatBudget(max)}`;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Value for <input type="datetime-local"> in the browser's local time. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
