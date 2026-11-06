import { clampToCallingHours, type CallingHoursConfig } from './calling-hours';
import type { RetrySettings } from './settings';

export type RetryKey = 'NO_ANSWER' | 'BUSY' | 'FAILED';

export type RetryDecision =
  | { action: 'RETRY'; at: Date; delayMinutes: number; key: RetryKey }
  | { action: 'STOP'; reason: 'MAX_ATTEMPTS' | 'NOT_RETRYABLE' };

export interface RetryInput {
  key: RetryKey | null;
  /** Customer-leg attempts already made for this lead, including the one that just ended. */
  attemptsMade: number;
  now: Date;
  policy: RetrySettings;
  callingHours: CallingHoursConfig;
  timeZone: string;
}

/**
 * Decide whether and when to retry an unanswered lead. Pure and deterministic so the rules can be
 * unit tested. Leads are never retried past `maxAttempts`, and retries are pushed into the next
 * open calling window.
 */
export function decideRetry(input: RetryInput): RetryDecision {
  if (!input.key) return { action: 'STOP', reason: 'NOT_RETRYABLE' };
  if (input.attemptsMade >= input.policy.maxAttempts) return { action: 'STOP', reason: 'MAX_ATTEMPTS' };
  const schedule = input.policy.delaysMinutes[input.key];
  const index = Math.max(0, Math.min(input.attemptsMade - 1, schedule.length - 1));
  const delayMinutes = schedule[index] ?? schedule[schedule.length - 1] ?? 60;
  const earliest = new Date(input.now.getTime() + delayMinutes * 60_000);
  const at = clampToCallingHours(earliest, input.callingHours, input.timeZone);
  return { action: 'RETRY', at, delayMinutes, key: input.key };
}

/** Map an outcome code to the retry schedule it uses. */
export function retryKeyForOutcome(code: string): RetryKey {
  if (code === 'BUSY') return 'BUSY';
  if (code === 'CALL_FAILED') return 'FAILED';
  return 'NO_ANSWER';
}
