import type { AgentStatus, CallStatus, LegRole, LegStatus, MembershipRole } from '@crm/shared';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; emailVerified: boolean };
  membership: null | { id: string; role: MembershipRole; permissions: string[]; tenant: { id: string; name: string; slug: string; timezone: string } };
  memberships: { id: string; role: string; tenantId: string; tenantName: string; tenantStatus: string }[];
}

export interface CallView {
  id: string;
  status: CallStatus;
  statusLabel: string;
  isSimulated: boolean;
  provider: 'PLIVO' | 'MOCK';
  callingMode: 'BROWSER' | 'PHONE';
  attemptNumber: number;
  initiatedAt: string;
  agentAnsweredAt: string | null;
  customerAnsweredAt: string | null;
  endedAt: string | null;
  talkSeconds: number | null;
  failureReason: string | null;
  hangupCause: string | null;
  wrapUpStatus: string;
  suggestedOutcome: string | null;
  recordingEnabled: boolean;
  legs: { id: string; role: LegRole; status: LegStatus; answeredAt: string | null; endedAt: string | null }[];
  lead: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    propertyInterest: string | null;
    preferredLocation: string | null;
    budgetMin: number | null;
    budgetMax: number | null;
    source: string | null;
    status: string;
    priority: string;
    attemptCount: number;
    consentStatus: string;
    lastCallOutcome: string | null;
  };
}

export interface AgentStateResponse {
  state: { status: AgentStatus; pauseReason: string | null; currentCallId: string | null; statusChangedAt: string; microphone: string | null; providerRegistered: boolean; deviceCheckedAt: string | null } | null;
  callingMode: 'BROWSER' | 'PHONE';
  telephony: { provider: 'PLIVO' | 'MOCK' | null; source: string; simulated: boolean; browserCalling: boolean; configured: boolean };
  agentPhoneConfigured: boolean;
  currentCall: CallView | null;
}

export interface Lead {
  id: string;
  fullName: string;
  phoneE164: string;
  phoneMasked?: boolean;
  email: string | null;
  propertyInterest: string | null;
  preferredLocation: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  source: string | null;
  status: string;
  priority: string;
  consentStatus: string;
  consentSource: string | null;
  consentCapturedAt: string | null;
  assignedMembershipId: string | null;
  assignedTo?: string | null;
  lastCallAt: string | null;
  lastCallOutcome: string | null;
  nextCallbackAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  queueItem?: { state: string; availableAt: string; attempts: number; queueId: string; isCallback: boolean; doneReason: string | null } | null;
}

export interface Member {
  id: string;
  role: MembershipRole;
  status: 'ACTIVE' | 'DEACTIVATED';
  user: { id: string; name: string; email: string; lastLoginAt: string | null };
  team: { id: string; name: string } | null;
  extraPermissions: string[];
  callingMode: 'BROWSER' | 'PHONE' | null;
  agentPhoneE164: string | null;
  telephonyIdentity: string;
  agentState: { status: AgentStatus; statusChangedAt: string; pauseReason: string | null } | null;
  createdAt: string;
}

export interface OutcomeDefinition {
  id: string;
  code: string;
  label: string;
  category: string;
  leadStatus: string | null;
  requiresNotes: boolean;
  requiresCallback: boolean;
  retryBehavior: string;
  suppressReason: string | null;
  isFinal: boolean;
  selectable: boolean;
  isSystem: boolean;
  active: boolean;
  sortOrder: number;
}

export interface QueueSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  active: boolean;
  callerId?: string | null;
  members?: { membershipId: string; name: string }[];
  counts: { ready: number; scheduled: number; callbacks: number; inProgress: number; done: number; eligibleNow: number };
}
