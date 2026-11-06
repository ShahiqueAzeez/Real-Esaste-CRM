import { z } from 'zod';
import {
  CALLING_MODES,
  CONSENT_STATUSES,
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  MEMBERSHIP_ROLES,
  OUTCOME_CATEGORIES,
  RETRY_BEHAVIORS,
  SUPPRESSION_CHANNELS,
  SUPPRESSION_REASONS,
  WA_PURPOSES,
} from './enums';
import { timeZoneSchema } from './settings';

/** Shared request schemas. The API validates every body/query with these; forms reuse them. */

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v));
const uuid = z.uuid();
const isoDate = z.coerce.date();

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(254));
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use letters and at least one number');

// ---------- auth ----------
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(256) });
export const selectMembershipSchema = z.object({ membershipId: uuid });
export const acceptInviteSchema = z.object({ token: z.string().min(20).max(200), name: trimmed(120).min(1, 'Enter your name'), password: passwordSchema });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema });

// ---------- members, teams ----------
export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(MEMBERSHIP_ROLES),
  teamId: uuid.optional().nullable(),
});
export const updateMemberSchema = z.object({
  role: z.enum(MEMBERSHIP_ROLES).optional(),
  status: z.enum(['ACTIVE', 'DEACTIVATED']).optional(),
  teamId: uuid.optional().nullable(),
  extraPermissions: z.array(z.string().max(64)).max(20).optional(),
  callingMode: z.enum(CALLING_MODES).optional().nullable(),
  agentPhone: optionalText(32),
  telephonyIdentity: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{3,64}$/, 'Letters, digits and underscore only')
    .optional(),
});
export const teamSchema = z.object({ name: trimmed(80).min(1), supervisorIds: z.array(uuid).max(50).default([]) });

// ---------- leads ----------
const budget = z.coerce.number().int().min(0).max(1e13).optional().nullable();
export const leadCreateSchema = z
  .object({
    fullName: trimmed(160).min(1, 'Name is required'),
    phone: trimmed(40).min(4, 'Phone is required'),
    email: z.union([emailSchema, z.literal('')]).optional().nullable().transform((v) => (v ? v : null)),
    propertyInterest: optionalText(200),
    preferredLocation: optionalText(200),
    budgetMin: budget,
    budgetMax: budget,
    source: optionalText(120),
    priority: z.enum(LEAD_PRIORITIES).default('NORMAL'),
    assignedMembershipId: uuid.optional().nullable(),
    consentStatus: z.enum(CONSENT_STATUSES).default('UNKNOWN'),
    consentSource: optionalText(200),
    consentCapturedAt: isoDate.optional().nullable(),
    consentEvidence: optionalText(1000),
    note: optionalText(4000),
    queueId: uuid.optional().nullable(),
  })
  .refine((v) => v.budgetMin == null || v.budgetMax == null || v.budgetMax >= v.budgetMin, { message: 'Maximum budget must be at least the minimum', path: ['budgetMax'] })
  .refine((v) => v.consentStatus !== 'GRANTED' || !!v.consentSource, { message: 'Record where consent came from', path: ['consentSource'] });

export const leadUpdateSchema = z.object({
  fullName: trimmed(160).min(1).optional(),
  email: z.union([emailSchema, z.literal('')]).optional().nullable().transform((v) => (v === undefined ? undefined : v ? v : null)),
  propertyInterest: optionalText(200),
  preferredLocation: optionalText(200),
  budgetMin: budget,
  budgetMax: budget,
  source: optionalText(120),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
});

export const leadSortFields = ['createdAt', 'updatedAt', 'fullName', 'lastCallAt', 'nextCallbackAt', 'attemptCount', 'priority', 'status'] as const;
export const leadListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  consentStatus: z.enum(CONSENT_STATUSES).optional(),
  assignedMembershipId: z.union([uuid, z.literal('unassigned')]).optional(),
  source: z.string().trim().max(120).optional(),
  queueId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(leadSortFields).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

export const bulkLeadSelectionSchema = z.object({
  leadIds: z.array(uuid).min(1).max(5000),
});
export const bulkAssignSchema = bulkLeadSelectionSchema.extend({
  membershipId: uuid.nullable(),
  queueId: uuid.optional(),
});
export const bulkStatusSchema = bulkLeadSelectionSchema.extend({ status: z.enum(LEAD_STATUSES) });
export const bulkQueueSchema = bulkLeadSelectionSchema.extend({ queueId: uuid, priority: z.coerce.number().int().min(-100).max(100).optional() });
export const leadNoteSchema = z.object({ body: trimmed(4000).min(1) });
export const consentUpdateSchema = z
  .object({
    status: z.enum(CONSENT_STATUSES),
    source: trimmed(200).min(1, 'Record where consent came from'),
    evidence: optionalText(1000),
    capturedAt: isoDate.optional().nullable(),
  });

// ---------- imports ----------
export const LEAD_IMPORT_FIELDS = [
  'fullName',
  'phone',
  'email',
  'propertyInterest',
  'preferredLocation',
  'budgetMin',
  'budgetMax',
  'source',
  'priority',
  'consentStatus',
  'consentSource',
  'consentCapturedAt',
  'notes',
] as const;
export type LeadImportField = (typeof LEAD_IMPORT_FIELDS)[number];

export const importOptionsSchema = z.object({
  duplicateStrategy: z.enum(['SKIP', 'UPDATE']).default('SKIP'),
  queueId: uuid.optional().nullable(),
  assignToMembershipId: uuid.optional().nullable(),
  defaultSource: optionalText(120),
  /** Bulk consent attestation for rows without a consent column. Requires a source. */
  consentAttestation: z
    .object({ source: trimmed(200).min(3), evidence: optionalText(1000), capturedAt: isoDate.optional().nullable() })
    .optional()
    .nullable(),
});
export const importMappingSchema = z.object({
  mapping: z.partialRecord(z.enum(LEAD_IMPORT_FIELDS), z.string().max(200).nullable()).refine((m) => !!m.phone && !!m.fullName, 'Map at least the name and phone columns'),
  options: importOptionsSchema.prefault({}),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

// ---------- compliance ----------
export const suppressionCreateSchema = z.object({
  phone: trimmed(40).min(4),
  channel: z.enum(SUPPRESSION_CHANNELS).default('ALL'),
  reason: z.enum(SUPPRESSION_REASONS).default('MANUAL'),
  note: optionalText(500),
  expiresAt: isoDate.optional().nullable(),
});
export const suppressionListQuerySchema = z.object({
  q: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------- queues ----------
export const queueSchema = z.object({
  name: trimmed(80).min(1),
  description: optionalText(300),
  active: z.boolean().default(true),
  callerId: optionalText(32),
  memberIds: z.array(uuid).max(500).default([]),
});

// ---------- calls, outcomes, callbacks ----------
export const outcomeSubmitSchema = z.object({
  outcomeCode: z.string().trim().min(1).max(40),
  notes: optionalText(4000),
  callbackAt: isoDate.optional().nullable(),
  callbackAssigneeId: uuid.optional().nullable(),
  next: z.enum(['READY', 'PAUSED']).default('READY'),
});
export type OutcomeSubmit = z.infer<typeof outcomeSubmitSchema>;

export const outcomeDefinitionSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use UPPER_SNAKE_CASE'),
  label: trimmed(80).min(1),
  category: z.enum(OUTCOME_CATEGORIES),
  leadStatus: z.enum(LEAD_STATUSES).nullable().default(null),
  requiresNotes: z.boolean().default(false),
  requiresCallback: z.boolean().default(false),
  retryBehavior: z.enum(RETRY_BEHAVIORS).default('NONE'),
  suppressReason: z.enum(SUPPRESSION_REASONS).nullable().default(null),
  isFinal: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10000).default(500),
});

export const callbackCreateSchema = z.object({
  leadId: uuid,
  dueAt: isoDate,
  notes: optionalText(2000),
  assignedMembershipId: uuid.optional().nullable(),
});
export const callbackUpdateSchema = z.object({
  dueAt: isoDate.optional(),
  notes: optionalText(2000),
  status: z.enum(['PENDING', 'COMPLETED', 'CANCELLED']).optional(),
  assignedMembershipId: uuid.optional().nullable(),
});

export const agentStatusSchema = z.object({
  status: z.enum(['READY', 'PAUSED', 'OFFLINE']),
  reason: optionalText(120),
});
export const deviceReportSchema = z.object({
  microphone: z.enum(['granted', 'denied', 'prompt', 'unavailable']),
  providerRegistered: z.boolean(),
  inputDeviceLabel: optionalText(200),
  outputDeviceLabel: optionalText(200),
});
export const recoverCallSchema = z.object({ notes: trimmed(2000).min(5, 'Explain why this call is being closed') });
export const monitorSchema = z.object({ mode: z.enum(['WHISPER', 'BARGE']) });

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export const callListQuerySchema = listQuerySchema.extend({
  membershipId: uuid.optional(),
  leadId: uuid.optional(),
  status: z.string().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export const reportQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  membershipId: uuid.optional(),
  queueId: uuid.optional(),
});

// ---------- integrations ----------
export const e164Schema = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Use E.164 format, e.g. +914412345678');
export const plivoConfigSchema = z.object({
  enabled: z.boolean().default(true),
  authId: z.string().trim().regex(/^[A-Z0-9]{10,40}$/i, 'Paste the Plivo Auth ID'),
  /** Omit to keep the stored token. */
  authToken: z.string().trim().min(10).max(200).optional(),
  callerIds: z.array(e164Schema).min(1, 'Add at least one rented Plivo number').max(50),
  defaultCallerId: e164Schema,
});
export const whatsappConfigSchema = z.object({
  enabled: z.boolean().default(true),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'Numeric phone number ID from WhatsApp Manager'),
  businessAccountId: optionalText(40),
  graphApiVersion: z.string().trim().regex(/^v\d{2}\.\d$/, 'e.g. v23.0').default('v23.0'),
  accessToken: z.string().trim().min(20).max(1000).optional(),
  appSecret: z.string().trim().min(16).max(200).optional(),
  webhookVerifyToken: z.string().trim().min(16).max(200).optional(),
});
export const whatsappTemplateSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Template names are lower_snake_case'),
  language: z.string().trim().min(2).max(10).default('en'),
  purpose: z.enum(WA_PURPOSES),
  category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']),
  /** Ordered body variables, e.g. ["lead.firstName", "callback.when", "org.name"]. */
  variables: z.array(z.enum(['lead.fullName', 'lead.firstName', 'callback.when', 'org.name', 'agent.name'])).max(10).default([]),
  active: z.boolean().default(true),
});
export const whatsappSendSchema = z.object({ leadId: uuid, templateId: uuid });

// ---------- platform / billing ----------
export const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, '3–40 lowercase letters, digits or hyphens');
export const createTenantSchema = z.object({
  name: trimmed(120).min(2),
  slug: slugSchema,
  timezone: timeZoneSchema.default('Asia/Kolkata'),
  planCode: z.string().trim().min(1).max(40),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
  trialDays: z.coerce.number().int().min(0).max(90).default(14),
  adminEmail: emailSchema,
});
export const updateTenantSchema = z.object({
  name: trimmed(120).min(2).optional(),
  timezone: timeZoneSchema.optional(),
});
export const tenantStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: optionalText(300) });
export const planSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
  name: trimmed(80).min(1),
  description: optionalText(300),
  monthlyPriceMinor: z.coerce.number().int().min(0),
  annualPriceMinor: z.coerce.number().int().min(0),
  currency: z.string().length(3).default('INR'),
  maxAgents: z.coerce.number().int().min(1).max(10000),
  maxLeadImportsPerMonth: z.coerce.number().int().min(0).max(10_000_000),
  maxConcurrentCalls: z.coerce.number().int().min(1).max(10000),
  features: z
    .object({ recording: z.boolean().default(false), whatsapp: z.boolean().default(false), coaching: z.boolean().default(false), advancedReports: z.boolean().default(false) })
    .prefault({}),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});
export const subscriptionUpdateSchema = z.object({
  planCode: z.string().trim().min(1).max(40).optional(),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']).optional(),
  currentPeriodEnd: isoDate.optional(),
  graceDays: z.coerce.number().int().min(0).max(60).optional(),
});
export const ledgerEntrySchema = z.object({
  type: z.enum(['CHARGE', 'PAYMENT', 'CREDIT', 'ADJUSTMENT']),
  amountMinor: z.coerce.number().int(),
  description: trimmed(300).min(1),
  reference: optionalText(120),
  isSimulated: z.boolean().default(false),
});
export const updateOrgSchema = z.object({ name: trimmed(120).min(2).optional(), timezone: timeZoneSchema.optional() });
