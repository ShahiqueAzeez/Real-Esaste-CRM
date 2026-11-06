import { TERMINAL_CALL_STATUSES, TERMINAL_LEG_STATUSES, type CallStatus, type LegStatus } from './enums';

/** Normalized end states a provider can report for one call leg. */
export type LegEndStatus = 'COMPLETED' | 'BUSY' | 'NO_ANSWER' | 'FAILED' | 'CANCELLED';

export type LegEvent =
  | { type: 'INITIATED' }
  | { type: 'RINGING' }
  | { type: 'ANSWERED' }
  | { type: 'ENDED'; endStatus: LegEndStatus };

const LEG_RANK: Record<LegStatus, number> = {
  QUEUED: 0,
  INITIATED: 1,
  RINGING: 2,
  ANSWERED: 3,
  COMPLETED: 4,
  BUSY: 4,
  NO_ANSWER: 4,
  FAILED: 4,
  CANCELLED: 4,
};

export function isTerminalLeg(status: LegStatus): boolean {
  return TERMINAL_LEG_STATUSES.includes(status);
}

export function isTerminalCall(status: CallStatus): boolean {
  return TERMINAL_CALL_STATUSES.includes(status);
}

export interface Transition<S> {
  status: S;
  changed: boolean;
  /** Why an event was ignored (duplicate, out of order, already terminal). */
  ignoredReason?: 'already_terminal' | 'stale' | 'same_state';
}

/**
 * Apply one provider event to a leg. Legs only move forward; late or repeated events are ignored,
 * which makes event processing safe against duplicates and out-of-order delivery.
 */
export function applyLegEvent(current: LegStatus, event: LegEvent): Transition<LegStatus> {
  if (isTerminalLeg(current)) return { status: current, changed: false, ignoredReason: 'already_terminal' };
  let target: LegStatus;
  switch (event.type) {
    case 'INITIATED':
      target = 'INITIATED';
      break;
    case 'RINGING':
      target = 'RINGING';
      break;
    case 'ANSWERED':
      target = 'ANSWERED';
      break;
    case 'ENDED':
      // A leg that was answered can only end as COMPLETED, whatever status string arrives.
      target = current === 'ANSWERED' ? 'COMPLETED' : event.endStatus;
      // A COMPLETED end without an answer means the far end never picked up.
      if (target === 'COMPLETED' && current !== 'ANSWERED') target = 'NO_ANSWER';
      break;
  }
  if (target === current) return { status: current, changed: false, ignoredReason: 'same_state' };
  if (event.type !== 'ENDED' && LEG_RANK[target] <= LEG_RANK[current]) {
    return { status: current, changed: false, ignoredReason: 'stale' };
  }
  return { status: target, changed: true };
}

const CALL_RANK: Record<CallStatus, number> = {
  INITIATING: 0,
  AGENT_RINGING: 1,
  AGENT_CONNECTED: 2,
  CUSTOMER_RINGING: 3,
  CONNECTED: 4,
  COMPLETED: 5,
  BUSY: 5,
  NO_ANSWER: 5,
  FAILED: 5,
  CANCELLED: 5,
};

export interface LegSnapshot {
  status: LegStatus;
  /** True once the leg has ever reached ANSWERED. */
  answered: boolean;
}

/**
 * Derive the call (attempt) status from its agent and customer legs. The result never moves
 * backwards and terminal statuses are absorbing.
 */
export function deriveCallStatus(prev: CallStatus, agent: LegSnapshot | null, customer: LegSnapshot | null): CallStatus {
  if (isTerminalCall(prev)) return prev;
  let next: CallStatus = prev;

  if (customer) {
    if (customer.answered) {
      if (isTerminalLeg(customer.status) || (agent && isTerminalLeg(agent.status))) next = 'COMPLETED';
      else next = 'CONNECTED';
    } else if (isTerminalLeg(customer.status)) {
      next = customer.status === 'COMPLETED' ? 'NO_ANSWER' : (customer.status as CallStatus);
    } else if (agent && isTerminalLeg(agent.status)) {
      // Agent dropped before the customer answered.
      next = 'CANCELLED';
    } else if (customer.status === 'RINGING') {
      next = 'CUSTOMER_RINGING';
    } else {
      next = agent?.answered ? 'AGENT_CONNECTED' : prev;
    }
  } else if (agent) {
    if (isTerminalLeg(agent.status)) {
      next = agent.answered || agent.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    } else if (agent.status === 'ANSWERED') next = 'AGENT_CONNECTED';
    else if (agent.status === 'RINGING') next = 'AGENT_RINGING';
    else next = 'INITIATING';
  }

  if (!isTerminalCall(next) && CALL_RANK[next] < CALL_RANK[prev]) return prev;
  return next;
}

/** Human-readable label for the agent UI. Never claims a connection the provider has not reported. */
export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  INITIATING: 'Starting call',
  AGENT_RINGING: 'Ringing your line',
  AGENT_CONNECTED: 'Your line is connected — dialling customer',
  CUSTOMER_RINGING: 'Ringing customer',
  CONNECTED: 'Connected',
  COMPLETED: 'Call ended',
  BUSY: 'Customer busy',
  NO_ANSWER: 'No answer',
  FAILED: 'Call failed',
  CANCELLED: 'Call cancelled',
};

/** Outcome code the agent UI pre-selects for an unanswered call. */
export function suggestedOutcomeFor(status: CallStatus): string | null {
  if (status === 'BUSY') return 'BUSY';
  if (status === 'NO_ANSWER') return 'NO_ANSWER';
  if (status === 'FAILED') return 'CALL_FAILED';
  return null;
}
