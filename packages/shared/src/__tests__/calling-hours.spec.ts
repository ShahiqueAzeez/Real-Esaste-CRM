import { clampToCallingHours, isWithinCallingHours, nextCallingWindowStart, zonedTimeToUtc, getZonedParts, validateWindows } from '../calling-hours';

const IST = 'Asia/Kolkata';
const weekdays = { enabled: true, windows: [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '10:00', end: '19:00' })) };

describe('zoned time conversion', () => {
  it('converts IST wall time to UTC', () => {
    // 2026-11-09 10:00 IST = 04:30 UTC
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 9, hour: 10, minute: 0 }, IST).toISOString()).toBe('2026-11-09T04:30:00.000Z');
  });

  it('handles DST zones', () => {
    // 2026-03-08 is a DST change day in New York; 10:00 local = 14:00 UTC (EDT, UTC-4)
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 10, minute: 0 }, 'America/New_York').toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('reads local weekday', () => {
    expect(getZonedParts(new Date('2026-11-08T20:00:00Z'), IST).weekday).toBe(1); // Mon 01:30 IST
  });
});

describe('calling windows', () => {
  it('detects times inside and outside windows', () => {
    expect(isWithinCallingHours(new Date('2026-11-09T05:00:00Z'), weekdays, IST)).toBe(true); // Mon 10:30
    expect(isWithinCallingHours(new Date('2026-11-09T13:45:00Z'), weekdays, IST)).toBe(false); // Mon 19:15
    expect(isWithinCallingHours(new Date('2026-11-08T05:00:00Z'), weekdays, IST)).toBe(false); // Sunday
  });

  it('end is exclusive', () => {
    expect(isWithinCallingHours(new Date('2026-11-09T13:30:00Z'), weekdays, IST)).toBe(false); // Mon 19:00
  });

  it('finds the next window start', () => {
    // Saturday 20:00 IST → Monday 10:00 IST
    expect(nextCallingWindowStart(new Date('2026-11-07T14:30:00Z'), weekdays, IST)?.toISOString()).toBe('2026-11-09T04:30:00.000Z');
    // Monday 08:00 IST → Monday 10:00 IST
    expect(nextCallingWindowStart(new Date('2026-11-09T02:30:00Z'), weekdays, IST)?.toISOString()).toBe('2026-11-09T04:30:00.000Z');
  });

  it('returns the same instant when already inside a window', () => {
    const d = new Date('2026-11-09T06:00:00Z');
    expect(clampToCallingHours(d, weekdays, IST)).toBe(d);
  });

  it('allows everything when disabled and returns null with no windows', () => {
    expect(isWithinCallingHours(new Date('2026-11-08T22:00:00Z'), { enabled: false, windows: [] }, IST)).toBe(true);
    expect(nextCallingWindowStart(new Date('2026-11-08T22:00:00Z'), { enabled: true, windows: [] }, IST)).toBeNull();
  });

  it('validates window shapes', () => {
    expect(validateWindows([{ day: 1, start: '19:00', end: '10:00' }])).toMatch(/cannot cross midnight/);
    expect(validateWindows([{ day: 1, start: '09:00', end: '21:00' }])).toBeNull();
  });
});
