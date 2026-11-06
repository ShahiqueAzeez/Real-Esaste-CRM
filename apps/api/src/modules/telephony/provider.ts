import type { LegEndStatus, LegRole, TelephonyProviderKind } from '@crm/shared';
import type { Readable } from 'node:stream';

/** Where a call leg goes: a SIP URI (browser identity) or a PSTN number in E.164. */
export interface LegTarget {
  kind: 'SIP' | 'PSTN';
  address: string;
}

export interface StartLegInput {
  tenantId: string;
  callId: string;
  legId: string;
  role: LegRole;
  from: string;
  to: LegTarget;
  ringTimeoutSeconds: number;
  timeLimitSeconds: number;
}

export interface StartLegResult {
  providerRequestId: string;
}

export interface ProviderCallDetails {
  providerCallId: string;
  billSeconds: number | null;
  durationSeconds: number | null;
  costMicros: bigint | null;
  currency: string | null;
  hangupCause: string | null;
  hangupSource: string | null;
  answered: boolean;
}

export interface TelephonyCapabilities {
  browserCalling: boolean;
  phoneCalling: boolean;
  /** Supervisor whisper / barge (Plivo MultiPartyCall coach mode). */
  coaching: boolean;
  recording: boolean;
  costReporting: boolean;
  simulated: boolean;
}

/**
 * Provider adapter. All provider-specific code lives behind this interface; the rest of the
 * application only sees normalized events (ProviderEvent) and these operations.
 */
export interface TelephonyProvider {
  readonly kind: TelephonyProviderKind;
  readonly capabilities: TelephonyCapabilities;
  readonly costCurrency: string | null;
  callerIds(): string[];
  defaultCallerId(): string | null;
  browserTarget(identity: string): LegTarget;
  startLeg(input: StartLegInput): Promise<StartLegResult>;
  hangupLeg(leg: { providerCallId: string | null; providerRequestId: string | null; legId: string; callId: string; tenantId: string; answered: boolean }): Promise<void>;
  addSupervisor(input: { tenantId: string; callId: string; legId: string; mpcName: string; from: string; to: LegTarget; coach: boolean }): Promise<StartLegResult>;
  setSupervisorMode(input: { mpcName: string; participantCallId: string; coach: boolean }): Promise<void>;
  getCallDetails(providerCallId: string): Promise<ProviderCallDetails | null>;
  fetchRecording(rec: { providerRecordingId: string; providerUrl: string | null }): Promise<{ body: Readable; contentType: string; contentLength?: number }>;
  deleteRecording(providerRecordingId: string): Promise<void>;
  createBrowserToken(identity: string, ttlSeconds: number): Promise<{ token: string; expiresAt: Date }>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}

/** Normalized call event produced by webhooks and the simulator. */
export interface ProviderEvent {
  provider: TelephonyProviderKind;
  source: string;
  tenantId: string;
  callId: string;
  legId: string;
  type: 'LEG_RINGING' | 'LEG_ANSWERED' | 'LEG_ENDED' | 'RECORDING' | 'MPC_STATUS';
  dedupeKey: string;
  occurredAt: Date;
  providerCallId?: string | null;
  providerRequestId?: string | null;
  endStatus?: LegEndStatus;
  durationSeconds?: number | null;
  billSeconds?: number | null;
  costMicros?: bigint | null;
  costCurrency?: string | null;
  hangupCause?: string | null;
  hangupCauseCode?: string | null;
  hangupSource?: string | null;
  recording?: { providerRecordingId: string; url: string | null; durationSeconds: number | null; format: string | null };
  signatureValid?: boolean;
  raw: Record<string, unknown>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Convert a decimal currency string ("0.01250") to integer micro-units without float error. */
export function decimalToMicros(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(6, '0').slice(0, 6);
  const micros = BigInt(m[2]!) * 1_000_000n + BigInt(frac || '0');
  return m[1] === '-' ? -micros : micros;
}
