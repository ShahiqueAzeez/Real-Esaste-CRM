import { LEAD_PRIORITIES, type ConsentStatus, type LeadImportField, type LeadPriority } from '@crm/shared';
import { normalizePhone } from '@crm/shared/phone';

/** Pure helpers for CSV lead import. No I/O, unit tested in import-rows.spec.ts. */

const HEADER_HINTS: Record<LeadImportField, string[]> = {
  fullName: ['name', 'full name', 'fullname', 'customer name', 'lead name', 'client name', 'contact name'],
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'contact', 'contact number', 'cell', 'whatsapp', 'mobile no', 'phone no'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  propertyInterest: ['property', 'property type', 'interest', 'requirement', 'configuration', 'bhk', 'property interest'],
  preferredLocation: ['location', 'area', 'locality', 'preferred location', 'city', 'preferred area'],
  budgetMin: ['budget min', 'min budget', 'budget from', 'budget', 'minimum budget'],
  budgetMax: ['budget max', 'max budget', 'budget to', 'maximum budget'],
  source: ['source', 'lead source', 'campaign', 'channel', 'utm source'],
  priority: ['priority'],
  consentStatus: ['consent', 'opt in', 'opt-in', 'optin', 'consent status', 'call consent'],
  consentSource: ['consent source', 'opt in source', 'consent channel'],
  consentCapturedAt: ['consent date', 'opt in date', 'consent captured at', 'consented at'],
  notes: ['notes', 'remarks', 'comments', 'note'],
};

const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').replace(/[^a-z0-9 -]/g, '').trim();

export function suggestMapping(headers: string[]): Partial<Record<LeadImportField, string>> {
  const result: Partial<Record<LeadImportField, string>> = {};
  const used = new Set<string>();
  for (const [field, hints] of Object.entries(HEADER_HINTS) as [LeadImportField, string[]][]) {
    const match = headers.find((h) => !used.has(h) && hints.includes(norm(h)));
    if (match) {
      result[field] = match;
      used.add(match);
    }
  }
  return result;
}

/** Parse Indian-style budgets: "45,00,000", "₹50 L", "1.2 Cr", "75 lakh", "900K". Returns whole units. */
export function parseBudget(raw: string | undefined): { value: number | null; error?: string } {
  const s = (raw ?? '').toString().trim().toLowerCase().replace(/₹|rs\.?|inr/g, '').replace(/,/g, '').trim();
  if (!s) return { value: null };
  const m = /^(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lacs|lakh|lakhs|k|thousand)?$/.exec(s);
  if (!m) return { value: null, error: `Unrecognised budget "${raw}"` };
  const n = Number(m[1]);
  const unit = m[2];
  const mult = !unit ? 1 : unit.startsWith('c') ? 1e7 : unit.startsWith('l') ? 1e5 : 1e3;
  const value = Math.round(n * mult);
  if (!Number.isFinite(value) || value > 1e13) return { value: null, error: `Budget out of range "${raw}"` };
  return { value };
}

export function parseConsent(raw: string | undefined): ConsentStatus | null {
  const s = (raw ?? '').toString().trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', '1', 'granted', 'given', 'opted in', 'opt-in', 'optin'].includes(s)) return 'GRANTED';
  if (['no', 'n', 'false', '0', 'revoked', 'withdrawn', 'opted out', 'opt-out', 'optout'].includes(s)) return 'REVOKED';
  return 'UNKNOWN';
}

export function parsePriority(raw: string | undefined): LeadPriority | null {
  const s = (raw ?? '').toString().trim().toUpperCase();
  if (!s) return null;
  return (LEAD_PRIORITIES as string[]).includes(s) ? (s as LeadPriority) : null;
}

export function parseDate(raw: string | undefined): Date | null | 'invalid' {
  const s = (raw ?? '').toString().trim();
  if (!s) return null;
  // Accept ISO and DD/MM/YYYY (common in India).
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  const d = dmy ? new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]))) : new Date(s);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface NormalizedImportRow {
  rowNumber: number;
  fullName: string;
  phoneE164: string;
  email: string | null;
  propertyInterest: string | null;
  preferredLocation: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  source: string | null;
  priority: LeadPriority;
  consentStatus: ConsentStatus | null;
  consentSource: string | null;
  consentCapturedAt: Date | null;
  notes: string | null;
  warnings: string[];
}

export type RowResult = { ok: true; row: NormalizedImportRow } | { ok: false; rowNumber: number; errors: string[] };

export interface RowContext {
  headerIndex: Map<string, number>;
  mapping: Partial<Record<LeadImportField, string | null>>;
  defaultCountry: string;
  allowedCountries: string[];
  defaultSource: string | null;
}

const clip = (v: string | undefined, max: number) => {
  const s = (v ?? '').toString().trim();
  return s ? s.slice(0, max) : null;
};

/** Validate and normalize one CSV data row (rowNumber is the 1-based line number in the file). */
export function validateRow(cells: string[], rowNumber: number, ctx: RowContext): RowResult {
  const get = (field: LeadImportField): string | undefined => {
    const col = ctx.mapping[field];
    if (!col) return undefined;
    const idx = ctx.headerIndex.get(col);
    return idx === undefined ? undefined : cells[idx];
  };
  const errors: string[] = [];
  const warnings: string[] = [];

  const fullName = clip(get('fullName'), 160);
  if (!fullName) errors.push('Name is empty');

  let phoneE164 = '';
  const phone = normalizePhone(get('phone'), ctx.defaultCountry, ctx.allowedCountries);
  if (!phone.ok) {
    errors.push(
      phone.error === 'EMPTY'
        ? 'Phone is empty'
        : phone.error === 'COUNTRY_NOT_ALLOWED'
          ? `Phone country not allowed (${String(get('phone')).slice(0, 20)})`
          : `Invalid phone "${String(get('phone')).slice(0, 20)}"`,
    );
  } else phoneE164 = phone.value.e164;

  let email = clip(get('email'), 254)?.toLowerCase() ?? null;
  if (email && !EMAIL.test(email)) {
    warnings.push(`Ignored invalid email "${email.slice(0, 40)}"`);
    email = null;
  }

  const bMin = parseBudget(get('budgetMin'));
  const bMax = parseBudget(get('budgetMax'));
  if (bMin.error) warnings.push(bMin.error);
  if (bMax.error) warnings.push(bMax.error);
  let budgetMin = bMin.value;
  let budgetMax = bMax.value;
  if (budgetMin !== null && budgetMax !== null && budgetMax < budgetMin) [budgetMin, budgetMax] = [budgetMax, budgetMin];

  const rawPriority = get('priority');
  const priority = parsePriority(rawPriority);
  if (rawPriority && !priority) warnings.push(`Unknown priority "${rawPriority.slice(0, 20)}", used NORMAL`);

  const consentStatus = parseConsent(get('consentStatus'));
  const consentDate = parseDate(get('consentCapturedAt'));
  if (consentDate === 'invalid') warnings.push('Ignored invalid consent date');

  if (errors.length) return { ok: false, rowNumber, errors };
  return {
    ok: true,
    row: {
      rowNumber,
      fullName: fullName!,
      phoneE164,
      email,
      propertyInterest: clip(get('propertyInterest'), 200),
      preferredLocation: clip(get('preferredLocation'), 200),
      budgetMin,
      budgetMax,
      source: clip(get('source'), 120) ?? ctx.defaultSource,
      priority: priority ?? 'NORMAL',
      consentStatus,
      consentSource: clip(get('consentSource'), 200),
      consentCapturedAt: consentDate === 'invalid' ? null : consentDate,
      notes: clip(get('notes'), 4000),
      warnings,
    },
  };
}
