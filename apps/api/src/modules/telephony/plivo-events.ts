import type { LegEndStatus } from '@crm/shared';
import { maskPhone } from '@crm/shared/phone';
import * as plivo from 'plivo';
import { createHash } from 'node:crypto';
import { decimalToMicros, type ProviderEvent } from './provider';

/** Pure mapping from Plivo callback parameters to normalized events. Unit tested. */

export type PlivoParams = Record<string, string | undefined>;

/**
 * Validate X-Plivo-Signature-V3 (or -Ma-V3) with the official SDK helper. `url` must be the exact
 * URL Plivo requested (PUBLIC_BASE_URL + original path and query). Any configured auth token may
 * match; the header can carry several comma-separated signatures.
 */
export function verifyPlivoSignature(input: {
  method: 'GET' | 'POST';
  url: string;
  params: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  authTokens: string[];
}): boolean {
  const h = (name: string) => {
    const v = input.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const nonce = h('x-plivo-signature-v3-nonce');
  const signatures = [h('x-plivo-signature-v3'), h('x-plivo-signature-ma-v3')].filter((s): s is string => !!s);
  if (!nonce || signatures.length === 0 || input.authTokens.length === 0) return false;
  const params = input.method === 'POST' ? input.params : {};
  for (const token of input.authTokens) {
    for (const sig of signatures) {
      try {
        if (plivo.validateV3Signature(input.method, input.url, nonce, token, sig, params)) return true;
      } catch {
        // malformed input → treat as invalid
      }
    }
  }
  return false;
}

/** Map Plivo's CallStatus + hangup data to a normalized end status. */
export function mapPlivoEndStatus(p: PlivoParams): LegEndStatus {
  const status = (p.CallStatus ?? '').toLowerCase();
  const cause = (p.HangupCauseName ?? p.HangupCause ?? '').toLowerCase();
  const answered = Number(p.BillDuration ?? 0) > 0 || !!p.AnswerTime;
  switch (status) {
    case 'busy':
      return 'BUSY';
    case 'no-answer':
    case 'timeout':
      return 'NO_ANSWER';
    case 'failed':
      return 'FAILED';
    case 'cancel':
    case 'canceled':
    case 'cancelled':
      return 'CANCELLED';
    case 'completed':
      if (answered) return 'COMPLETED';
      break;
  }
  if (/busy|rejected|declined/.test(cause)) return 'BUSY';
  if (/no answer|no_answer|timeout|unanswered/.test(cause)) return 'NO_ANSWER';
  if (/cancel/.test(cause)) return 'CANCELLED';
  if (answered) return 'COMPLETED';
  return status === 'completed' ? 'NO_ANSWER' : 'FAILED';
}

/** Plivo timestamps look like "2026-11-06 18:00:00" (UTC). */
export function parsePlivoTime(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(/T/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const PHONE_KEYS = new Set(['From', 'To', 'CallerName', 'ForwardedFrom', 'ParticipantCallFrom', 'ParticipantCallTo']);

/** Keep provider identifiers and statuses for audit; mask phone numbers. */
export function redactPlivoParams(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (PHONE_KEYS.has(k) && typeof v === 'string') out[k] = v.startsWith('sip:') ? 'sip:[redacted]' : maskPhone(v.startsWith('+') ? v : `+${v}`);
    else out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

const num = (v: string | undefined) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

export function plivoLegEvent(
  kind: 'ring' | 'answer' | 'hangup',
  p: PlivoParams,
  ids: { tenantId: string; callId: string; legId: string },
  signatureValid: boolean,
): ProviderEvent {
  const base = {
    provider: 'PLIVO' as const,
    source: `webhook:${kind}`,
    ...ids,
    providerCallId: p.CallUUID ?? null,
    providerRequestId: p.RequestUUID ?? null,
    signatureValid,
    raw: redactPlivoParams(p),
  };
  if (kind === 'ring') return { ...base, type: 'LEG_RINGING', dedupeKey: `ring:${ids.legId}`, occurredAt: new Date() };
  if (kind === 'answer') return { ...base, type: 'LEG_ANSWERED', dedupeKey: `answer:${ids.legId}`, occurredAt: parsePlivoTime(p.AnswerTime) ?? new Date() };
  return {
    ...base,
    type: 'LEG_ENDED',
    dedupeKey: `hangup:${ids.legId}`,
    occurredAt: parsePlivoTime(p.EndTime) ?? new Date(),
    endStatus: mapPlivoEndStatus(p),
    durationSeconds: num(p.Duration),
    billSeconds: num(p.BillDuration),
    costMicros: decimalToMicros(p.TotalCost),
    hangupCause: p.HangupCauseName ?? p.HangupCause ?? null,
    hangupCauseCode: p.HangupCauseCode ?? null,
    hangupSource: p.HangupSource ?? null,
  };
}

/** Status callbacks for API-added participants (supervisor legs). Parameter names are tolerant. */
export function plivoParticipantEvent(p: PlivoParams, ids: { tenantId: string; callId: string; legId: string }, signatureValid: boolean): ProviderEvent | null {
  const status = (p.CallStatus ?? p.ParticipantCallStatus ?? '').toLowerCase();
  if (status === 'in-progress' || status === 'answered') {
    return { provider: 'PLIVO', source: 'webhook:participant', ...ids, type: 'LEG_ANSWERED', dedupeKey: `participant-answer:${ids.legId}`, occurredAt: new Date(), providerCallId: p.CallUUID ?? null, signatureValid, raw: redactPlivoParams(p) };
  }
  if (status === 'ringing') {
    return { provider: 'PLIVO', source: 'webhook:participant', ...ids, type: 'LEG_RINGING', dedupeKey: `participant-ring:${ids.legId}`, occurredAt: new Date(), providerCallId: p.CallUUID ?? null, signatureValid, raw: redactPlivoParams(p) };
  }
  if (['completed', 'busy', 'failed', 'no-answer', 'timeout', 'cancel', 'canceled'].includes(status)) {
    return { ...plivoLegEvent('hangup', p, ids, signatureValid), source: 'webhook:participant', dedupeKey: `participant-hangup:${ids.legId}` };
  }
  return null;
}

/** Recording callback (MPC recordingCallbackUrl). Field names vary; parse tolerantly. */
export function plivoRecordingEvent(p: PlivoParams, ids: { tenantId: string; callId: string; legId: string }, signatureValid: boolean): ProviderEvent | null {
  const recordingId = p.RecordingID ?? p.RecordingId ?? p.RecordingUUID ?? p.recording_id;
  if (!recordingId) return null;
  const url = p.RecordingURL ?? p.RecordingUrl ?? p.recording_url ?? null;
  const durationMs = num(p.RecordingDurationMs ?? p.RecordingDurationMS);
  const duration = num(p.RecordingDuration) ?? (durationMs !== null ? Math.round(durationMs / 1000) : null);
  return {
    provider: 'PLIVO',
    source: 'webhook:recording',
    ...ids,
    type: 'RECORDING',
    dedupeKey: `recording:${recordingId}`,
    occurredAt: new Date(),
    signatureValid,
    recording: { providerRecordingId: recordingId, url, durationSeconds: duration, format: (p.RecordingFormat ?? 'mp3').toLowerCase() },
    raw: redactPlivoParams(p),
  };
}

/** MPC status callbacks are stored for audit only; their exact schema is not relied on. */
export function plivoMpcEvent(p: PlivoParams, ids: { tenantId: string; callId: string; legId: string }, signatureValid: boolean): ProviderEvent {
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(p).sort())).digest('hex').slice(0, 32);
  return { provider: 'PLIVO', source: 'webhook:mpc', ...ids, type: 'MPC_STATUS', dedupeKey: `mpc:${digest}`, occurredAt: new Date(), signatureValid, raw: redactPlivoParams(p) };
}
