import { CALL_STATUS_LABEL, type CallStatus } from '@crm/shared';
import { titleCase } from '@/lib/format';
import { Badge, type Tone } from './ui/badge';

const AGENT: Record<string, [string, Tone]> = {
  OFFLINE: ['Offline', 'neutral'],
  READY: ['Ready', 'ok'],
  DIALING: ['Dialling', 'info'],
  ON_CALL: ['On call', 'brand'],
  WRAP_UP: ['Wrap-up', 'warn'],
  PAUSED: ['Paused', 'warn'],
};

const CALL_TONE: Record<string, Tone> = {
  INITIATING: 'info',
  AGENT_RINGING: 'info',
  AGENT_CONNECTED: 'info',
  CUSTOMER_RINGING: 'info',
  CONNECTED: 'ok',
  COMPLETED: 'neutral',
  BUSY: 'warn',
  NO_ANSWER: 'warn',
  FAILED: 'bad',
  CANCELLED: 'neutral',
};

const GENERIC: Record<string, Tone> = {
  // leads
  NEW: 'info', CONTACTED: 'neutral', INTERESTED: 'ok', FOLLOW_UP: 'brand', CALLBACK: 'brand', NOT_INTERESTED: 'neutral', CONVERTED: 'ok', INVALID: 'bad', DO_NOT_CALL: 'bad', CLOSED: 'neutral',
  // consent
  GRANTED: 'ok', UNKNOWN: 'warn', REVOKED: 'bad',
  // callbacks / imports / generic
  PENDING: 'warn', COMPLETED: 'ok', CANCELLED: 'neutral', MISSED: 'bad', UPLOADED: 'neutral', VALIDATING: 'info', PREVIEW_READY: 'brand', IMPORTING: 'info', FAILED: 'bad',
  // integrations / subscriptions
  CONFIGURED: 'ok', NOT_CONFIGURED: 'neutral', ERROR: 'bad', DISABLED: 'neutral', TRIALING: 'info', ACTIVE: 'ok', PAST_DUE: 'warn', SUSPENDED: 'bad', EXPIRED: 'bad', DEACTIVATED: 'neutral',
  // messages / recordings
  QUEUED: 'info', SENT: 'ok', DELIVERED: 'ok', READ: 'ok', RECEIVED: 'info', SKIPPED: 'neutral', AVAILABLE: 'ok', DELETED: 'neutral',
  // priority
  LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warn', URGENT: 'bad',
};

export function AgentStatusBadge({ status }: { status: string | null | undefined }) {
  const [label, tone] = AGENT[status ?? 'OFFLINE'] ?? ['Unknown', 'neutral'];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export function CallStatusBadge({ status }: { status: string }) {
  return <Badge tone={CALL_TONE[status] ?? 'neutral'}>{CALL_STATUS_LABEL[status as CallStatus] ?? titleCase(status)}</Badge>;
}

export function StatusBadge({ value, label }: { value: string | null | undefined; label?: string }) {
  if (!value) return <span className="text-muted">—</span>;
  return <Badge tone={GENERIC[value] ?? 'neutral'}>{label ?? titleCase(value)}</Badge>;
}
