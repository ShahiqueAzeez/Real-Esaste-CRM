import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export interface NormalizedPhone {
  e164: string;
  country: string | undefined;
  type: string | undefined;
}

export type PhoneError = 'EMPTY' | 'UNPARSEABLE' | 'INVALID' | 'COUNTRY_NOT_ALLOWED';

/**
 * Normalize user-supplied phone numbers to E.164 using full libphonenumber metadata.
 * Imported only by the API (kept out of the shared index so the web bundle stays small).
 */
export function normalizePhone(
  input: string | null | undefined,
  defaultCountry = 'IN',
  allowedCountries?: string[],
): { ok: true; value: NormalizedPhone } | { ok: false; error: PhoneError } {
  const raw = (input ?? '').toString().trim();
  if (!raw) return { ok: false, error: 'EMPTY' };
  // Common spreadsheet artefacts: leading apostrophe, "00" international prefix, trailing ".0".
  let cleaned = raw.replace(/^'/, '').replace(/\.0$/, '');
  if (/^00\d/.test(cleaned)) cleaned = `+${cleaned.slice(2)}`;
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry as CountryCode);
  if (!parsed) return { ok: false, error: 'UNPARSEABLE' };
  if (!parsed.isValid()) return { ok: false, error: 'INVALID' };
  if (allowedCountries && allowedCountries.length > 0 && (!parsed.country || !allowedCountries.includes(parsed.country))) {
    return { ok: false, error: 'COUNTRY_NOT_ALLOWED' };
  }
  return { ok: true, value: { e164: parsed.number, country: parsed.country, type: parsed.getType() } };
}

export function phoneCountry(e164: string): string | undefined {
  return parsePhoneNumberFromString(e164)?.country;
}

/** Mask a phone number for logs and low-privilege displays: +91•••••43210 → keeps last 4 digits. */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const digits = e164.replace(/[^\d+]/g, '');
  if (digits.length <= 6) return '•'.repeat(digits.length);
  return `${digits.slice(0, 3)}${'•'.repeat(digits.length - 7)}${digits.slice(-4)}`;
}
