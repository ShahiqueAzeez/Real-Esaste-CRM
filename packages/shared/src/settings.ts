import { z } from 'zod';
import { CALLING_MODES } from './enums';
import { validateWindows, isValidTimeZone, type CallingWindow } from './calling-hours';

const HHMM = /^([01]\d|2[0-4]):[0-5]\d$/;

export const callingWindowSchema = z.object({
  day: z.number().int().min(0).max(6),
  start: z.string().regex(HHMM, 'Use HH:MM'),
  end: z.string().regex(HHMM, 'Use HH:MM'),
});

/**
 * Conservative default calling window: Monday–Saturday 10:00–19:00 tenant local time.
 * Tenants must confirm the hours that apply to them; see docs/COMPLIANCE_INDIA.md.
 */
export const DEFAULT_CALLING_WINDOWS: CallingWindow[] = [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '10:00', end: '19:00' }));

export const retryScheduleSchema = z.object({
  NO_ANSWER: z.array(z.number().int().min(5).max(43200)).min(1).default([120, 1440]),
  BUSY: z.array(z.number().int().min(5).max(43200)).min(1).default([30, 240]),
  FAILED: z.array(z.number().int().min(5).max(43200)).min(1).default([60, 360]),
});

export const tenantSettingsSchema = z.object({
  callingHours: z
    .object({
      enabled: z.boolean().default(true),
      windows: z.array(callingWindowSchema).max(42).default(DEFAULT_CALLING_WINDOWS),
    })
    .superRefine((v, ctx) => {
      const err = validateWindows(v.windows);
      if (err) ctx.addIssue({ code: 'custom', message: err, path: ['windows'] });
    })
    .prefault({}),
  consent: z
    .object({
      /** When true (default) only leads with recorded consent are dialled. */
      requireConsentForCalls: z.boolean().default(true),
      requireConsentForWhatsApp: z.boolean().default(true),
    })
    .prefault({}),
  retry: z
    .object({
      /** Total attempts including the first one. */
      maxAttempts: z.number().int().min(1).max(10).default(3),
      /** Minutes to wait before the next attempt, indexed by attempts already made (last value repeats). */
      delaysMinutes: retryScheduleSchema.prefault({}),
    })
    .prefault({}),
  calling: z
    .object({
      defaultMode: z.enum(CALLING_MODES).default('BROWSER'),
      customerRingTimeoutSeconds: z.number().int().min(10).max(90).default(30),
      agentRingTimeoutSeconds: z.number().int().min(10).max(60).default(20),
      maxCallMinutes: z.number().int().min(1).max(240).default(60),
      autoWrapUpUnanswered: z.boolean().default(true),
      /** ISO 3166 alpha-2 country codes leads may be dialled in. Protects against toll fraud. */
      allowedCountries: z.array(z.string().length(2)).min(1).default(['IN']),
      maxCallsPerAgentPerHour: z.number().int().min(1).max(500).default(120),
    })
    .prefault({}),
  recording: z
    .object({
      enabled: z.boolean().default(false),
      noticeText: z.string().max(300).default('This call may be recorded for quality and training purposes.'),
      playNotice: z.boolean().default(true),
      retentionDays: z.number().int().min(1).max(3650).default(90),
    })
    .prefault({}),
  leads: z
    .object({
      /** Leads assigned to an agent are only dialled by that agent. */
      strictOwnership: z.boolean().default(true),
      /** Delete leads with no activity for this many days. Null keeps leads until deleted manually. */
      retentionDays: z.number().int().min(30).max(3650).nullable().default(null),
      defaultCountry: z.string().length(2).default('IN'),
    })
    .prefault({}),
  whatsapp: z
    .object({
      sendCallbackConfirmation: z.boolean().default(false),
      sendMissedCallFollowup: z.boolean().default(false),
      maxMessagesPerLeadPer7Days: z.number().int().min(1).max(20).default(2),
    })
    .prefault({}),
  costEstimates: z
    .object({
      currency: z.string().length(3).default('INR'),
      /** Tenant-configured estimate (minor units per minute). Never presented as an invoice. */
      agentLegPerMinuteMinor: z.number().int().min(0).nullable().default(null),
      customerLegPerMinuteMinor: z.number().int().min(0).nullable().default(null),
    })
    .prefault({}),
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type RetrySettings = TenantSettings['retry'];

export function parseTenantSettings(raw: unknown): TenantSettings {
  const result = tenantSettingsSchema.safeParse(raw ?? {});
  return result.success ? result.data : tenantSettingsSchema.parse({});
}

export const DEFAULT_TENANT_SETTINGS: TenantSettings = tenantSettingsSchema.parse({});

/** Partial update payload: each top-level section is optional and merged over current values. */
export const tenantSettingsPatchSchema = z.object({
  callingHours: z.object({ enabled: z.boolean().optional(), windows: z.array(callingWindowSchema).max(42).optional() }).optional(),
  consent: tenantSettingsSchema.shape.consent.unwrap().partial().optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).optional(),
      delaysMinutes: retryScheduleSchema.partial().optional(),
    })
    .optional(),
  calling: tenantSettingsSchema.shape.calling.unwrap().partial().optional(),
  recording: tenantSettingsSchema.shape.recording.unwrap().partial().optional(),
  leads: tenantSettingsSchema.shape.leads.unwrap().partial().optional(),
  whatsapp: tenantSettingsSchema.shape.whatsapp.unwrap().partial().optional(),
  costEstimates: tenantSettingsSchema.shape.costEstimates.unwrap().partial().optional(),
});
export type TenantSettingsPatch = z.infer<typeof tenantSettingsPatchSchema>;

export function mergeTenantSettings(current: TenantSettings, patch: TenantSettingsPatch): TenantSettings {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const base = (current as Record<string, unknown>)[key] as Record<string, unknown>;
    if (key === 'retry') {
      const r = value as TenantSettingsPatch['retry'];
      merged.retry = {
        ...current.retry,
        ...(r?.maxAttempts !== undefined ? { maxAttempts: r.maxAttempts } : {}),
        delaysMinutes: { ...current.retry.delaysMinutes, ...(r?.delaysMinutes ?? {}) },
      };
    } else {
      merged[key] = { ...base, ...(value as Record<string, unknown>) };
    }
  }
  return tenantSettingsSchema.parse(merged);
}

export const timeZoneSchema = z.string().refine(isValidTimeZone, 'Unknown IANA time zone');
