import { createHmac } from 'node:crypto';
import { decimalToMicros } from './provider';
import { mapPlivoEndStatus, parsePlivoTime, plivoLegEvent, plivoRecordingEvent, redactPlivoParams, verifyPlivoSignature } from './plivo-events';
import { PlivoProvider } from './plivo.provider';

/** Independent re-implementation of Plivo's documented V3 scheme, to test our URL handling. */
function signV3(url: string, params: Record<string, string>, nonce: string, token: string): string {
  const u = new URL(url);
  const query = [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const keys = Object.keys(params).sort();
  let base = `${u.protocol}//${u.host}${u.pathname}`;
  if (query.length || keys.length) base += `?${query.join('&')}`;
  if (query.length && keys.length) base += '.';
  base += keys.map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', token).update(`${base}.${nonce}`).digest('base64');
}

describe('Plivo status mapping', () => {
  it.each([
    [{ CallStatus: 'busy' }, 'BUSY'],
    [{ CallStatus: 'no-answer' }, 'NO_ANSWER'],
    [{ CallStatus: 'timeout' }, 'NO_ANSWER'],
    [{ CallStatus: 'failed' }, 'FAILED'],
    [{ CallStatus: 'cancel' }, 'CANCELLED'],
    [{ CallStatus: 'completed', BillDuration: '42' }, 'COMPLETED'],
    [{ CallStatus: 'completed', BillDuration: '0', HangupCauseName: 'Busy Line' }, 'BUSY'],
    [{ CallStatus: 'completed', BillDuration: '0' }, 'NO_ANSWER'],
    [{ CallStatus: '', HangupCauseName: 'Rejected' }, 'BUSY'],
  ])('%j → %s', (params, expected) => {
    expect(mapPlivoEndStatus(params)).toBe(expected);
  });

  it('parses hangup callbacks into normalized events', () => {
    const evt = plivoLegEvent(
      'hangup',
      { CallUUID: 'uuid-1', RequestUUID: 'req-1', CallStatus: 'completed', Duration: '65', BillDuration: '60', TotalCost: '0.01250', HangupCauseName: 'NORMAL_CLEARING', HangupSource: 'Callee', EndTime: '2026-11-06 18:00:00', To: '919876543210' },
      { tenantId: 't', callId: 'c', legId: 'l' },
      true,
    );
    expect(evt).toMatchObject({ type: 'LEG_ENDED', dedupeKey: 'hangup:l', endStatus: 'COMPLETED', billSeconds: 60, durationSeconds: 65, costMicros: 12500n, hangupSource: 'Callee', providerCallId: 'uuid-1' });
    expect(evt.occurredAt.toISOString()).toBe('2026-11-06T18:00:00.000Z');
    expect(String(evt.raw.To)).not.toContain('98765');
  });

  it('parses recording callbacks tolerantly', () => {
    const evt = plivoRecordingEvent({ RecordingID: 'rec-1', RecordingURL: 'https://media.plivo.com/x.mp3', RecordingDurationMs: '61000' }, { tenantId: 't', callId: 'c', legId: 'l' }, true);
    expect(evt?.recording).toEqual({ providerRecordingId: 'rec-1', url: 'https://media.plivo.com/x.mp3', durationSeconds: 61, format: 'mp3' });
    expect(plivoRecordingEvent({}, { tenantId: 't', callId: 'c', legId: 'l' }, true)).toBeNull();
  });

  it('converts decimal costs to micro-units exactly', () => {
    expect(decimalToMicros('0.0035')).toBe(3500n);
    expect(decimalToMicros('12')).toBe(12_000_000n);
    expect(decimalToMicros('1.1234567')).toBe(1_123_456n);
    expect(decimalToMicros('abc')).toBeNull();
    expect(decimalToMicros(undefined)).toBeNull();
  });

  it('parses Plivo timestamps as UTC', () => {
    expect(parsePlivoTime('2026-11-06 18:00:00')?.toISOString()).toBe('2026-11-06T18:00:00.000Z');
    expect(parsePlivoTime('nonsense')).toBeNull();
  });

  it('masks phone numbers in stored payloads', () => {
    expect(redactPlivoParams({ From: '919876543210', To: 'sip:crm_x@phone.plivo.com', CallUUID: 'u' })).toEqual({ From: '+91••••••3210', To: 'sip:[redacted]', CallUUID: 'u' });
  });
});

describe('Plivo V3 signature verification (SDK helper)', () => {
  const url = 'https://crm.example.com/api/webhooks/plivo/hangup?callId=C1&legId=L1&role=agent';
  const params = { CallUUID: 'uuid-1', CallStatus: 'completed', BillDuration: '10' };
  const nonce = '12345678901234567890';
  const token = 'secret-token-abc';

  it('accepts a valid signature, including in a comma-separated list', () => {
    const sig = signV3(url, params, nonce, token);
    const headers = { 'x-plivo-signature-v3': `wrong,${sig}`, 'x-plivo-signature-v3-nonce': nonce };
    expect(verifyPlivoSignature({ method: 'POST', url, params, headers, authTokens: ['other', token] })).toBe(true);
  });

  it('rejects tampered parameters, wrong URLs, wrong tokens and missing headers', () => {
    const sig = signV3(url, params, nonce, token);
    const headers = { 'x-plivo-signature-v3': sig, 'x-plivo-signature-v3-nonce': nonce };
    expect(verifyPlivoSignature({ method: 'POST', url, params: { ...params, CallStatus: 'busy' }, headers, authTokens: [token] })).toBe(false);
    expect(verifyPlivoSignature({ method: 'POST', url: url.replace('legId=L1', 'legId=L2'), params, headers, authTokens: [token] })).toBe(false);
    expect(verifyPlivoSignature({ method: 'POST', url, params, headers, authTokens: ['nope'] })).toBe(false);
    expect(verifyPlivoSignature({ method: 'POST', url, params, headers: { 'x-plivo-signature-v3': sig }, authTokens: [token] })).toBe(false);
    expect(verifyPlivoSignature({ method: 'POST', url, params, headers, authTokens: [] })).toBe(false);
  });
});

describe('Plivo answer XML', () => {
  it('joins agents to the call MPC with recording when enabled', () => {
    const xml = PlivoProvider.answerXml({ role: 'agent', mpcName: 'call-1', statusCallbackUrl: 'https://crm.example.com/api/webhooks/plivo/mpc?callId=1&legId=2', recording: { enabled: true, callbackUrl: 'https://crm.example.com/api/webhooks/plivo/recording?callId=1&legId=2', notice: 'notice' }, maxDurationSeconds: 3600 });
    expect(xml).toContain('<MultiPartyCall');
    expect(xml).toContain('role="Agent"');
    expect(xml).toContain('record="true"');
    expect(xml).toContain('>call-1</MultiPartyCall>');
    expect(xml).not.toContain('<Speak');
  });

  it('plays the recording notice to customers before joining', () => {
    const xml = PlivoProvider.answerXml({ role: 'customer', mpcName: 'call-1', statusCallbackUrl: 'https://crm.example.com/api/webhooks/plivo/mpc?callId=1&legId=3', recording: { enabled: true, callbackUrl: 'https://crm.example.com/api/webhooks/plivo/recording?callId=1&legId=3', notice: 'This call may be recorded.' }, maxDurationSeconds: 3600 });
    expect(xml.indexOf('<Speak')).toBeLessThan(xml.indexOf('<MultiPartyCall'));
    expect(xml).toContain('role="Customer"');
    expect(xml).toContain('endMpcOnExit="true"');
  });
});
