/**
 * Timezone-aware calling-window helpers built on Intl only (no tz database dependency).
 * Windows are expressed in the tenant's local time; instants are always UTC `Date`s.
 */
export interface CallingWindow {
  /** 0 = Sunday … 6 = Saturday, local to the tenant timezone. */
  day: number;
  /** "HH:MM" 24-hour, inclusive. */
  start: string;
  /** "HH:MM" 24-hour, exclusive; must be after start (windows do not cross midnight). */
  end: string;
}

export interface CallingHoursConfig {
  enabled: boolean;
  windows: CallingWindow[];
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0-6, Sunday = 0
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds (local = utc + offset). */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a local wall-clock time in `timeZone` to a UTC instant (DST-safe, two-pass). */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  const first = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  const second = guess - timeZoneOffsetMs(new Date(first), timeZone);
  return new Date(second);
}

export function parseHHMM(value: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid time "${value}"`);
  return h * 60 + min;
}

export function isWithinCallingHours(date: Date, cfg: CallingHoursConfig, timeZone: string): boolean {
  if (!cfg.enabled) return true;
  const p = getZonedParts(date, timeZone);
  const minutes = p.hour * 60 + p.minute;
  return cfg.windows.some((w) => w.day === p.weekday && minutes >= parseHHMM(w.start) && minutes < parseHHMM(w.end));
}

/**
 * Earliest instant >= `from` that falls inside a calling window. Returns `from` when it is already
 * inside a window, or null when no window exists in the coming 8 days (misconfiguration).
 */
export function nextCallingWindowStart(from: Date, cfg: CallingHoursConfig, timeZone: string): Date | null {
  if (!cfg.enabled || isWithinCallingHours(from, cfg, timeZone)) return from;
  if (cfg.windows.length === 0) return null;
  const p = getZonedParts(from, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
    const weekday = d.getUTCDay();
    const windows = cfg.windows.filter((w) => w.day === weekday).sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));
    for (const w of windows) {
      const startMin = parseHHMM(w.start);
      const candidate = zonedTimeToUtc(
        { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: Math.floor(startMin / 60), minute: startMin % 60 },
        timeZone,
      );
      if (candidate.getTime() >= from.getTime()) return candidate;
    }
  }
  return null;
}

/** Push `date` forward into the next calling window when it falls outside one. */
export function clampToCallingHours(date: Date, cfg: CallingHoursConfig, timeZone: string): Date {
  return nextCallingWindowStart(date, cfg, timeZone) ?? date;
}

export function validateWindows(windows: CallingWindow[]): string | null {
  for (const w of windows) {
    if (w.day < 0 || w.day > 6) return `Invalid day ${w.day}`;
    let s: number;
    let e: number;
    try {
      s = parseHHMM(w.start);
      e = parseHHMM(w.end);
    } catch (err) {
      return (err as Error).message;
    }
    if (e <= s) return `Window ${w.start}-${w.end} must end after it starts (windows cannot cross midnight)`;
  }
  return null;
}
