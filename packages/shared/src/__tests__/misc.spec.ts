import { sanitizeCsvCell, toCsv } from '../csv';
import { normalizePhone, maskPhone } from '../phone';
import { mergeTenantSettings, DEFAULT_TENANT_SETTINGS, parseTenantSettings } from '../settings';
import { permissionsFor, scopeFor } from '../permissions';
import { importMappingSchema, leadCreateSchema, passwordSchema } from '../schemas';

describe('CSV formula injection protection', () => {
  it.each(['=SUM(A1)', '+91 98', '-2+3', '@cmd', '\tx'])('prefixes %p', (v) => {
    expect(sanitizeCsvCell(v).startsWith("'")).toBe(true);
  });
  it('leaves safe values alone and quotes properly', () => {
    expect(sanitizeCsvCell('Chennai')).toBe('Chennai');
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"']])).toBe('a,b\r\n"x,y","say ""hi"""\r\n');
  });
});

describe('phone normalization', () => {
  it('normalizes Indian mobiles in many formats', () => {
    for (const input of ['98765 43210', '+91 98765-43210', '09876543210', '919876543210', "'9876543210", '00919876543210']) {
      const r = normalizePhone(input, 'IN');
      expect(r).toMatchObject({ ok: true, value: { e164: '+919876543210', country: 'IN' } });
    }
  });
  it('rejects invalid and disallowed numbers', () => {
    expect(normalizePhone('12345', 'IN')).toMatchObject({ ok: false });
    expect(normalizePhone('', 'IN')).toEqual({ ok: false, error: 'EMPTY' });
    expect(normalizePhone('+1 415 555 2671', 'IN', ['IN'])).toEqual({ ok: false, error: 'COUNTRY_NOT_ALLOWED' });
  });
  it('masks numbers', () => {
    expect(maskPhone('+919876543210')).toBe('+91••••••3210');
  });
});

describe('tenant settings', () => {
  it('fills defaults', () => {
    const s = parseTenantSettings({});
    expect(s.consent.requireConsentForCalls).toBe(true);
    expect(s.retry.maxAttempts).toBe(3);
    expect(s.callingHours.windows).toHaveLength(6);
  });
  it('merges partial patches and validates', () => {
    const merged = mergeTenantSettings(DEFAULT_TENANT_SETTINGS, { retry: { delaysMinutes: { BUSY: [15] } }, recording: { enabled: true } });
    expect(merged.retry.delaysMinutes.BUSY).toEqual([15]);
    expect(merged.retry.delaysMinutes.NO_ANSWER).toEqual([120, 1440]);
    expect(merged.recording.enabled).toBe(true);
    expect(() => mergeTenantSettings(DEFAULT_TENANT_SETTINGS, { callingHours: { windows: [{ day: 1, start: '20:00', end: '09:00' }] } })).toThrow();
  });
});

describe('permissions', () => {
  it('gives agents only their own data', () => {
    const p = permissionsFor('AGENT');
    expect(scopeFor(p, 'leads')).toBe('own');
    expect(p.has('leads:export')).toBe(false);
    expect(p.has('calls:dial')).toBe(true);
  });
  it('keeps billing away from supervisors unless granted', () => {
    expect(permissionsFor('SUPERVISOR').has('billing:read')).toBe(false);
    expect(permissionsFor('SUPERVISOR', ['billing:read']).has('billing:read')).toBe(true);
    expect(permissionsFor('SUPERVISOR', ['users:manage']).has('users:manage')).toBe(false);
  });
  it('gives admins all-scope access but not dialling', () => {
    const p = permissionsFor('ORG_ADMIN');
    expect(scopeFor(p, 'calls')).toBe('all');
    expect(p.has('calls:dial')).toBe(false);
  });
});

describe('schemas', () => {
  it('requires a consent source when consent is granted', () => {
    expect(leadCreateSchema.safeParse({ fullName: 'A', phone: '9876543210', consentStatus: 'GRANTED' }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ fullName: 'A', phone: '9876543210', consentStatus: 'GRANTED', consentSource: 'Website form' }).success).toBe(true);
  });
  it('requires name and phone mapping', () => {
    expect(importMappingSchema.safeParse({ mapping: { fullName: 'Name' } }).success).toBe(false);
    expect(importMappingSchema.safeParse({ mapping: { fullName: 'Name', phone: 'Mobile' } }).success).toBe(true);
  });
  it('enforces password strength', () => {
    expect(passwordSchema.safeParse('short1').success).toBe(false);
    expect(passwordSchema.safeParse('longenoughpassword').success).toBe(false);
    expect(passwordSchema.safeParse('longenough123').success).toBe(true);
  });
});
