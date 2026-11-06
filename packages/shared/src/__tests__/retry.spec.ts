import { decideRetry, retryKeyForOutcome } from '../retry';
import { DEFAULT_TENANT_SETTINGS } from '../settings';

const IST = 'Asia/Kolkata';
const always = { enabled: false, windows: [] };
const policy = DEFAULT_TENANT_SETTINGS.retry; // maxAttempts 3, NO_ANSWER [120, 1440]

describe('decideRetry', () => {
  const now = new Date('2026-11-09T05:00:00Z');

  it('uses the schedule for the attempt number', () => {
    const first = decideRetry({ key: 'NO_ANSWER', attemptsMade: 1, now, policy, callingHours: always, timeZone: IST });
    expect(first).toMatchObject({ action: 'RETRY', delayMinutes: 120 });
    const second = decideRetry({ key: 'NO_ANSWER', attemptsMade: 2, now, policy, callingHours: always, timeZone: IST });
    expect(second).toMatchObject({ action: 'RETRY', delayMinutes: 1440 });
  });

  it('stops at the maximum number of attempts', () => {
    expect(decideRetry({ key: 'NO_ANSWER', attemptsMade: 3, now, policy, callingHours: always, timeZone: IST })).toEqual({ action: 'STOP', reason: 'MAX_ATTEMPTS' });
  });

  it('does not retry non-retryable outcomes', () => {
    expect(decideRetry({ key: null, attemptsMade: 1, now, policy, callingHours: always, timeZone: IST })).toEqual({ action: 'STOP', reason: 'NOT_RETRYABLE' });
  });

  it('pushes retries into the next calling window', () => {
    const hours = DEFAULT_TENANT_SETTINGS.callingHours; // Mon-Sat 10-19 IST
    // Saturday 18:30 IST + 30 minutes busy delay = 19:00 → Monday 10:00 IST
    const sat = new Date('2026-11-07T13:00:00Z');
    const decision = decideRetry({ key: 'BUSY', attemptsMade: 1, now: sat, policy, callingHours: hours, timeZone: IST });
    expect(decision.action).toBe('RETRY');
    if (decision.action === 'RETRY') expect(decision.at.toISOString()).toBe('2026-11-09T04:30:00.000Z');
  });

  it('reuses the last delay when attempts exceed the schedule length', () => {
    const p = { ...policy, maxAttempts: 6 };
    expect(decideRetry({ key: 'BUSY', attemptsMade: 5, now, policy: p, callingHours: always, timeZone: IST })).toMatchObject({ delayMinutes: 240 });
  });

  it('maps outcome codes to schedules', () => {
    expect(retryKeyForOutcome('BUSY')).toBe('BUSY');
    expect(retryKeyForOutcome('CALL_FAILED')).toBe('FAILED');
    expect(retryKeyForOutcome('NO_ANSWER')).toBe('NO_ANSWER');
  });
});
