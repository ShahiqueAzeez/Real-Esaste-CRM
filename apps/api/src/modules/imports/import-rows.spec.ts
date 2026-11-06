import { parseBudget, parseConsent, parseDate, parsePriority, suggestMapping, validateRow } from './import-rows';

describe('import row parsing', () => {
  it.each([
    ['45,00,000', 4_500_000],
    ['₹50 L', 5_000_000],
    ['1.2 Cr', 12_000_000],
    ['75 lakh', 7_500_000],
    ['900K', 900_000],
    ['Rs. 2 crore', 20_000_000],
  ])('parses budget %p', (raw, value) => {
    expect(parseBudget(raw)).toEqual({ value });
  });

  it('reports unparseable budgets as warnings', () => {
    expect(parseBudget('around fifty')).toMatchObject({ value: null, error: expect.stringContaining('Unrecognised') });
    expect(parseBudget('')).toEqual({ value: null });
  });

  it('parses consent, priority and dates', () => {
    expect(parseConsent('Yes')).toBe('GRANTED');
    expect(parseConsent('opted out')).toBe('REVOKED');
    expect(parseConsent('maybe')).toBe('UNKNOWN');
    expect(parseConsent('')).toBeNull();
    expect(parsePriority('high')).toBe('HIGH');
    expect(parsePriority('vip')).toBeNull();
    expect((parseDate('15/08/2026') as Date).toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(parseDate('31/31/2026')).toBe('invalid');
  });

  it('suggests a mapping from common header names', () => {
    expect(suggestMapping(['Customer Name', 'Mobile Number', 'E-mail', 'Area', 'Budget', 'Lead Source', 'Remarks'])).toEqual({
      fullName: 'Customer Name',
      phone: 'Mobile Number',
      email: 'E-mail',
      preferredLocation: 'Area',
      budgetMin: 'Budget',
      source: 'Lead Source',
      notes: 'Remarks',
    });
  });

  const ctx = {
    headerIndex: new Map([['Name', 0], ['Phone', 1], ['Email', 2], ['Min', 3], ['Max', 4], ['Priority', 5]]),
    mapping: { fullName: 'Name', phone: 'Phone', email: 'Email', budgetMin: 'Min', budgetMax: 'Max', priority: 'Priority' },
    defaultCountry: 'IN',
    allowedCountries: ['IN'],
    defaultSource: 'Import',
  };

  it('normalizes a valid row and swaps an inverted budget range', () => {
    const r = validateRow(['  Priya  ', '98765 43210', 'PRIYA@EXAMPLE.COM', '90L', '60L', 'urgent'], 2, ctx);
    expect(r).toMatchObject({ ok: true, row: { fullName: 'Priya', phoneE164: '+919876543210', email: 'priya@example.com', budgetMin: 6_000_000, budgetMax: 9_000_000, priority: 'URGENT', source: 'Import' } });
  });

  it('collects errors and warnings', () => {
    expect(validateRow(['', '123', '', '', '', ''], 3, ctx)).toEqual({ ok: false, rowNumber: 3, errors: ['Name is empty', 'Invalid phone "123"'] });
    expect(validateRow(['A', '+1 415 555 2671', '', '', '', ''], 4, ctx)).toMatchObject({ ok: false, errors: [expect.stringContaining('country not allowed')] });
    const warn = validateRow(['A', '9876543210', 'not-an-email', 'lots', '', 'vip'], 5, ctx);
    expect(warn.ok && warn.row.warnings.length).toBe(3);
  });
});
