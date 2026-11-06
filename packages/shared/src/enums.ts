/**
 * Enumerations shared by the API, worker and web app. Values mirror the Prisma enums in
 * apps/api/prisma/schema.prisma; keep both in sync (a unit test in the API checks this).
 */
function values<T extends Record<string, string>>(obj: T): [T[keyof T], ...T[keyof T][]] {
  return Object.values(obj) as [T[keyof T], ...T[keyof T][]];
}

export const MembershipRole = { ORG_ADMIN: 'ORG_ADMIN', SUPERVISOR: 'SUPERVISOR', AGENT: 'AGENT' } as const;
export type MembershipRole = (typeof MembershipRole)[keyof typeof MembershipRole];
export const MEMBERSHIP_ROLES = values(MembershipRole);

export const MembershipStatus = { ACTIVE: 'ACTIVE', DEACTIVATED: 'DEACTIVATED' } as const;
export type MembershipStatus = (typeof MembershipStatus)[keyof typeof MembershipStatus];

export const TenantStatus = { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED' } as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

export const AgentStatus = {
  OFFLINE: 'OFFLINE',
  READY: 'READY',
  DIALING: 'DIALING',
  ON_CALL: 'ON_CALL',
  WRAP_UP: 'WRAP_UP',
  PAUSED: 'PAUSED',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];
export const AGENT_STATUSES = values(AgentStatus);

export const CallingMode = { BROWSER: 'BROWSER', PHONE: 'PHONE' } as const;
export type CallingMode = (typeof CallingMode)[keyof typeof CallingMode];
export const CALLING_MODES = values(CallingMode);

export const LeadStatus = {
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  INTERESTED: 'INTERESTED',
  FOLLOW_UP: 'FOLLOW_UP',
  CALLBACK: 'CALLBACK',
  NOT_INTERESTED: 'NOT_INTERESTED',
  CONVERTED: 'CONVERTED',
  INVALID: 'INVALID',
  DO_NOT_CALL: 'DO_NOT_CALL',
  CLOSED: 'CLOSED',
} as const;
export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus];
export const LEAD_STATUSES = values(LeadStatus);
/** Lead statuses that end dialling for the lead. */
export const FINAL_LEAD_STATUSES: LeadStatus[] = ['NOT_INTERESTED', 'CONVERTED', 'INVALID', 'DO_NOT_CALL', 'CLOSED'];

export const LeadPriority = { LOW: 'LOW', NORMAL: 'NORMAL', HIGH: 'HIGH', URGENT: 'URGENT' } as const;
export type LeadPriority = (typeof LeadPriority)[keyof typeof LeadPriority];
export const LEAD_PRIORITIES = values(LeadPriority);
export const PRIORITY_WEIGHT: Record<LeadPriority, number> = { LOW: 0, NORMAL: 10, HIGH: 20, URGENT: 30 };

export const ConsentStatus = { UNKNOWN: 'UNKNOWN', GRANTED: 'GRANTED', REVOKED: 'REVOKED' } as const;
export type ConsentStatus = (typeof ConsentStatus)[keyof typeof ConsentStatus];
export const CONSENT_STATUSES = values(ConsentStatus);

export const SuppressionChannel = { ALL: 'ALL', VOICE: 'VOICE', WHATSAPP: 'WHATSAPP' } as const;
export type SuppressionChannel = (typeof SuppressionChannel)[keyof typeof SuppressionChannel];
export const SUPPRESSION_CHANNELS = values(SuppressionChannel);

export const SuppressionReason = {
  DO_NOT_CALL: 'DO_NOT_CALL',
  OPT_OUT: 'OPT_OUT',
  WRONG_NUMBER: 'WRONG_NUMBER',
  INVALID_NUMBER: 'INVALID_NUMBER',
  REGULATORY: 'REGULATORY',
  MANUAL: 'MANUAL',
} as const;
export type SuppressionReason = (typeof SuppressionReason)[keyof typeof SuppressionReason];
export const SUPPRESSION_REASONS = values(SuppressionReason);

export const ImportStatus = {
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  PREVIEW_READY: 'PREVIEW_READY',
  IMPORTING: 'IMPORTING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type ImportStatus = (typeof ImportStatus)[keyof typeof ImportStatus];

export const QueueItemState = { WAITING: 'WAITING', IN_PROGRESS: 'IN_PROGRESS', DONE: 'DONE', REMOVED: 'REMOVED' } as const;
export type QueueItemState = (typeof QueueItemState)[keyof typeof QueueItemState];

export const CallStatus = {
  INITIATING: 'INITIATING',
  AGENT_RINGING: 'AGENT_RINGING',
  AGENT_CONNECTED: 'AGENT_CONNECTED',
  CUSTOMER_RINGING: 'CUSTOMER_RINGING',
  CONNECTED: 'CONNECTED',
  COMPLETED: 'COMPLETED',
  BUSY: 'BUSY',
  NO_ANSWER: 'NO_ANSWER',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];
export const CALL_STATUSES = values(CallStatus);
export const TERMINAL_CALL_STATUSES: CallStatus[] = ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'];
export const ACTIVE_CALL_STATUSES: CallStatus[] = ['INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED'];

export const LegRole = { AGENT: 'AGENT', CUSTOMER: 'CUSTOMER', SUPERVISOR: 'SUPERVISOR' } as const;
export type LegRole = (typeof LegRole)[keyof typeof LegRole];

export const LegStatus = {
  QUEUED: 'QUEUED',
  INITIATED: 'INITIATED',
  RINGING: 'RINGING',
  ANSWERED: 'ANSWERED',
  COMPLETED: 'COMPLETED',
  BUSY: 'BUSY',
  NO_ANSWER: 'NO_ANSWER',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type LegStatus = (typeof LegStatus)[keyof typeof LegStatus];
export const TERMINAL_LEG_STATUSES: LegStatus[] = ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED'];

export const TelephonyProviderKind = { PLIVO: 'PLIVO', MOCK: 'MOCK' } as const;
export type TelephonyProviderKind = (typeof TelephonyProviderKind)[keyof typeof TelephonyProviderKind];

export const WrapUpStatus = { NOT_REQUIRED: 'NOT_REQUIRED', PENDING: 'PENDING', DONE: 'DONE', RECOVERED: 'RECOVERED' } as const;
export type WrapUpStatus = (typeof WrapUpStatus)[keyof typeof WrapUpStatus];

export const CostSource = { PROVIDER: 'PROVIDER', ESTIMATE: 'ESTIMATE', NONE: 'NONE' } as const;
export type CostSource = (typeof CostSource)[keyof typeof CostSource];

export const CallbackStatus = { PENDING: 'PENDING', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', MISSED: 'MISSED' } as const;
export type CallbackStatus = (typeof CallbackStatus)[keyof typeof CallbackStatus];

export const RecordingStatus = { PENDING: 'PENDING', AVAILABLE: 'AVAILABLE', FAILED: 'FAILED', DELETED: 'DELETED' } as const;
export type RecordingStatus = (typeof RecordingStatus)[keyof typeof RecordingStatus];

export const WaDirection = { OUTBOUND: 'OUTBOUND', INBOUND: 'INBOUND' } as const;
export type WaDirection = (typeof WaDirection)[keyof typeof WaDirection];

export const WaStatus = {
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  RECEIVED: 'RECEIVED',
  SKIPPED: 'SKIPPED',
} as const;
export type WaStatus = (typeof WaStatus)[keyof typeof WaStatus];

export const WaPurpose = {
  CALLBACK_CONFIRMATION: 'CALLBACK_CONFIRMATION',
  MISSED_CALL_FOLLOWUP: 'MISSED_CALL_FOLLOWUP',
  MANUAL: 'MANUAL',
} as const;
export type WaPurpose = (typeof WaPurpose)[keyof typeof WaPurpose];
export const WA_PURPOSES = values(WaPurpose);

export const ProviderType = { PLIVO: 'PLIVO', WHATSAPP: 'WHATSAPP' } as const;
export type ProviderType = (typeof ProviderType)[keyof typeof ProviderType];

export const IntegrationStatus = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CONFIGURED: 'CONFIGURED',
  ERROR: 'ERROR',
  DISABLED: 'DISABLED',
} as const;
export type IntegrationStatus = (typeof IntegrationStatus)[keyof typeof IntegrationStatus];

export const SubscriptionStatus = {
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];
/** Subscription statuses that allow normal operation (calling, importing, inviting). */
export const OPERATIONAL_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

export const BillingPeriod = { MONTHLY: 'MONTHLY', ANNUAL: 'ANNUAL' } as const;
export type BillingPeriod = (typeof BillingPeriod)[keyof typeof BillingPeriod];

export const LedgerEntryType = { CHARGE: 'CHARGE', PAYMENT: 'PAYMENT', CREDIT: 'CREDIT', ADJUSTMENT: 'ADJUSTMENT' } as const;
export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export const UsageKind = {
  VOICE_LEG_SECONDS: 'VOICE_LEG_SECONDS',
  VOICE_COST: 'VOICE_COST',
  WHATSAPP_MESSAGE: 'WHATSAPP_MESSAGE',
  LEAD_IMPORT: 'LEAD_IMPORT',
  RECORDING_SECONDS: 'RECORDING_SECONDS',
} as const;
export type UsageKind = (typeof UsageKind)[keyof typeof UsageKind];

export const OutcomeCategory = {
  POSITIVE: 'POSITIVE',
  NEUTRAL: 'NEUTRAL',
  NEGATIVE: 'NEGATIVE',
  CONVERTED: 'CONVERTED',
  NO_CONTACT: 'NO_CONTACT',
  INVALID: 'INVALID',
  DO_NOT_CALL: 'DO_NOT_CALL',
} as const;
export type OutcomeCategory = (typeof OutcomeCategory)[keyof typeof OutcomeCategory];
export const OUTCOME_CATEGORIES = values(OutcomeCategory);

export const RetryBehavior = { NONE: 'NONE', RETRY: 'RETRY', CALLBACK: 'CALLBACK' } as const;
export type RetryBehavior = (typeof RetryBehavior)[keyof typeof RetryBehavior];
export const RETRY_BEHAVIORS = values(RetryBehavior);

export const MonitorMode = { WHISPER: 'WHISPER', BARGE: 'BARGE' } as const;
export type MonitorMode = (typeof MonitorMode)[keyof typeof MonitorMode];
