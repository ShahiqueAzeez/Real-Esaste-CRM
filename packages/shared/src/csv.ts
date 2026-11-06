/**
 * Neutralise spreadsheet formula injection (CSV injection) in exported cells. Any cell that starts
 * with a character a spreadsheet would treat as a formula is prefixed with a single quote.
 * See OWASP "CSV Injection".
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r', '\n'];

export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (s.length > 0 && FORMULA_TRIGGERS.includes(s[0]!)) s = `'${s}`;
  return s;
}

/** Quote a sanitized cell for RFC 4180 output. */
export function csvEscape(value: unknown): string {
  const s = sanitizeCsvCell(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\r\n') + '\r\n';
}
