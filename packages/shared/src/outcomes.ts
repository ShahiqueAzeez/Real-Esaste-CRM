import type { LeadStatus, OutcomeCategory, RetryBehavior, SuppressionReason } from './enums';

export interface OutcomeDefinitionSeed {
  code: string;
  label: string;
  category: OutcomeCategory;
  /** Lead status to apply; null leaves the lead's status unchanged. */
  leadStatus: LeadStatus | null;
  requiresNotes: boolean;
  requiresCallback: boolean;
  retryBehavior: RetryBehavior;
  /** Adds the number to the suppression list with this reason. */
  suppressReason: SuppressionReason | null;
  /** Ends dialling for the lead. */
  isFinal: boolean;
  /** Available to agents in the wrap-up form (system outcomes are applied automatically). */
  selectable: boolean;
  sortOrder: number;
}

/** Built-in outcomes created for every tenant. Labels and requirements are editable per tenant. */
export const DEFAULT_OUTCOMES: OutcomeDefinitionSeed[] = [
  { code: 'INTERESTED', label: 'Interested', category: 'POSITIVE', leadStatus: 'INTERESTED', requiresNotes: true, requiresCallback: false, retryBehavior: 'NONE', suppressReason: null, isFinal: false, selectable: true, sortOrder: 10 },
  { code: 'FOLLOW_UP', label: 'Follow-up required', category: 'POSITIVE', leadStatus: 'FOLLOW_UP', requiresNotes: true, requiresCallback: true, retryBehavior: 'CALLBACK', suppressReason: null, isFinal: false, selectable: true, sortOrder: 20 },
  { code: 'CALLBACK', label: 'Callback scheduled', category: 'NEUTRAL', leadStatus: 'CALLBACK', requiresNotes: false, requiresCallback: true, retryBehavior: 'CALLBACK', suppressReason: null, isFinal: false, selectable: true, sortOrder: 30 },
  { code: 'NOT_INTERESTED', label: 'Not interested', category: 'NEGATIVE', leadStatus: 'NOT_INTERESTED', requiresNotes: false, requiresCallback: false, retryBehavior: 'NONE', suppressReason: null, isFinal: true, selectable: true, sortOrder: 40 },
  { code: 'NO_ANSWER', label: 'No answer', category: 'NO_CONTACT', leadStatus: null, requiresNotes: false, requiresCallback: false, retryBehavior: 'RETRY', suppressReason: null, isFinal: false, selectable: true, sortOrder: 50 },
  { code: 'BUSY', label: 'Busy', category: 'NO_CONTACT', leadStatus: null, requiresNotes: false, requiresCallback: false, retryBehavior: 'RETRY', suppressReason: null, isFinal: false, selectable: true, sortOrder: 60 },
  { code: 'WRONG_NUMBER', label: 'Wrong number', category: 'INVALID', leadStatus: 'INVALID', requiresNotes: false, requiresCallback: false, retryBehavior: 'NONE', suppressReason: 'WRONG_NUMBER', isFinal: true, selectable: true, sortOrder: 70 },
  { code: 'INVALID_NUMBER', label: 'Invalid number', category: 'INVALID', leadStatus: 'INVALID', requiresNotes: false, requiresCallback: false, retryBehavior: 'NONE', suppressReason: 'INVALID_NUMBER', isFinal: true, selectable: true, sortOrder: 80 },
  { code: 'DO_NOT_CALL', label: 'Do not call', category: 'DO_NOT_CALL', leadStatus: 'DO_NOT_CALL', requiresNotes: false, requiresCallback: false, retryBehavior: 'NONE', suppressReason: 'DO_NOT_CALL', isFinal: true, selectable: true, sortOrder: 90 },
  { code: 'CONVERTED', label: 'Converted', category: 'CONVERTED', leadStatus: 'CONVERTED', requiresNotes: true, requiresCallback: false, retryBehavior: 'NONE', suppressReason: null, isFinal: true, selectable: true, sortOrder: 100 },
  { code: 'CALL_FAILED', label: 'Call failed (technical)', category: 'NO_CONTACT', leadStatus: null, requiresNotes: false, requiresCallback: false, retryBehavior: 'RETRY', suppressReason: null, isFinal: false, selectable: true, sortOrder: 110 },
  { code: 'SYSTEM_RECOVERED', label: 'Closed by supervisor (recovery)', category: 'NEUTRAL', leadStatus: null, requiresNotes: true, requiresCallback: false, retryBehavior: 'RETRY', suppressReason: null, isFinal: false, selectable: false, sortOrder: 900 },
];

export const SYSTEM_OUTCOME_CODES = ['NO_ANSWER', 'BUSY', 'CALL_FAILED', 'SYSTEM_RECOVERED', 'DO_NOT_CALL'];
