import type { AgentStatus, CallStatus, LegRole, LegStatus } from './enums';

/** Socket.IO event names. Rooms: tenant:<id>, tenant:<id>:supervisors, membership:<id>. */
export const RealtimeEvent = {
  AGENT_STATE: 'agent.state',
  CALL_UPDATED: 'call.updated',
  /** Sent to one agent just before the server rings their browser, enabling safe auto-answer. */
  EXPECT_INCOMING: 'call.expect-incoming',
  IMPORT_PROGRESS: 'import.progress',
  NOTIFICATION: 'notification',
  QUEUE_CHANGED: 'queue.changed',
} as const;
export type RealtimeEvent = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

export interface AgentStatePayload {
  membershipId: string;
  status: AgentStatus;
  pauseReason: string | null;
  currentCallId: string | null;
  statusChangedAt: string;
}

export interface CallUpdatedPayload {
  callId: string;
  membershipId: string;
  leadId: string;
  status: CallStatus;
  isSimulated: boolean;
  legs: { role: LegRole; status: LegStatus }[];
  customerAnsweredAt: string | null;
  endedAt: string | null;
  failureReason: string | null;
  wrapUpStatus: string;
}

export interface ExpectIncomingPayload {
  callId: string;
  purpose: 'AGENT_LEG' | 'MONITOR';
  expiresAt: string;
}

export interface ImportProgressPayload {
  importId: string;
  status: string;
  processed: number;
  total: number;
}
