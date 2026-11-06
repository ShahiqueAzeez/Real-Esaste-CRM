import { Logger } from '@nestjs/common';
import * as plivo from 'plivo';
import { Readable } from 'node:stream';
import { Errors } from '../../common/errors';
import {
  decimalToMicros,
  ProviderError,
  type LegTarget,
  type ProviderCallDetails,
  type StartLegInput,
  type StartLegResult,
  type TelephonyCapabilities,
  type TelephonyProvider,
} from './provider';

export interface PlivoCredentials {
  authId: string;
  authToken: string;
}

export interface PlivoSettings {
  callerIds: string[];
  defaultCallerId: string | null;
  costCurrency: string;
  sipUriTemplate: string;
  timeoutMs: number;
  /** Builds absolute webhook URLs (PUBLIC_BASE_URL + /api/webhooks + path). */
  webhookUrl: (path: string) => string;
}

const noPlus = (e164: string) => e164.replace(/^\+/, '');

function toProviderError(err: unknown, action: string): ProviderError {
  const e = err as { message?: string; statusCode?: number; status?: number };
  const status = e.statusCode ?? e.status;
  const retryable = status === undefined || status >= 500 || status === 429;
  return new ProviderError(`Plivo ${action} failed${status ? ` (HTTP ${status})` : ''}: ${(e.message ?? 'unknown error').slice(0, 300)}`, retryable);
}

/**
 * Plivo Voice adapter (official `plivo` Node SDK). Calls are server-initiated only; each attempt
 * is a MultiPartyCall named call-<id> so supervisors can join in coach mode. See
 * docs/TELEPHONY_PLIVO.md for the verified API surface and the remaining unknowns.
 */
export class PlivoProvider implements TelephonyProvider {
  readonly kind = 'PLIVO' as const;
  readonly capabilities: TelephonyCapabilities = {
    browserCalling: true,
    phoneCalling: true,
    coaching: true,
    recording: true,
    costReporting: true,
    simulated: false,
  };
  private readonly logger = new Logger('Plivo');
  private readonly client: plivo.Client;

  constructor(
    private readonly creds: PlivoCredentials,
    private readonly settings: PlivoSettings,
  ) {
    this.client = new plivo.Client(creds.authId, creds.authToken, { timeout: settings.timeoutMs });
  }

  get costCurrency(): string {
    return this.settings.costCurrency;
  }

  callerIds(): string[] {
    return this.settings.callerIds;
  }

  defaultCallerId(): string | null {
    return this.settings.defaultCallerId;
  }

  browserTarget(identity: string): LegTarget {
    return { kind: 'SIP', address: this.settings.sipUriTemplate.replace('{identity}', identity) };
  }

  static mpcName(callId: string): string {
    return `call-${callId}`;
  }

  private legQuery(input: { callId: string; legId: string; role: string }): string {
    return `callId=${encodeURIComponent(input.callId)}&legId=${encodeURIComponent(input.legId)}&role=${input.role.toLowerCase()}`;
  }

  async startLeg(input: StartLegInput): Promise<StartLegResult> {
    const q = this.legQuery(input);
    const to = input.to.kind === 'SIP' ? input.to.address : noPlus(input.to.address);
    try {
      const res = await this.client.calls.create(noPlus(input.from), to, this.settings.webhookUrl(`/plivo/answer?${q}`), {
        answerMethod: 'POST',
        ringUrl: this.settings.webhookUrl(`/plivo/ring?${q}`),
        ringMethod: 'POST',
        hangupUrl: this.settings.webhookUrl(`/plivo/hangup?${q}`),
        hangupMethod: 'POST',
        fallbackAnswerUrl: this.settings.webhookUrl(`/plivo/fallback?${q}`),
        fallbackMethod: 'POST',
        ringTimeout: input.ringTimeoutSeconds,
        timeLimit: input.timeLimitSeconds,
        // Arrives in the browser SDK as an X-PH-* header so the agent page can match the call.
        sipHeaders: input.to.kind === 'SIP' ? `CrmCallId=${input.callId}` : undefined,
      });
      const requestUuid = Array.isArray(res.requestUuid) ? res.requestUuid[0] : res.requestUuid;
      if (!requestUuid) throw new ProviderError('Plivo did not return a request UUID', true);
      return { providerRequestId: String(requestUuid) };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw toProviderError(err, 'call create');
    }
  }

  async hangupLeg(leg: { providerCallId: string | null; providerRequestId: string | null }): Promise<void> {
    try {
      if (leg.providerCallId) await this.client.calls.hangup(leg.providerCallId);
      else if (leg.providerRequestId) await this.client.calls.cancel(leg.providerRequestId);
    } catch (err) {
      const pe = toProviderError(err, 'hangup');
      // 404 means the leg already ended; that is the desired state.
      if (/HTTP 404/.test(pe.message)) return;
      throw pe;
    }
  }

  async addSupervisor(input: { callId: string; legId: string; mpcName: string; from: string; to: LegTarget; coach: boolean }): Promise<StartLegResult> {
    try {
      const res = (await this.client.multiPartyCalls.addParticipant('supervisor', {
        friendlyName: input.mpcName,
        from: noPlus(input.from),
        to: input.to.kind === 'SIP' ? input.to.address : noPlus(input.to.address),
        coachMode: input.coach,
        callStatusCallbackUrl: this.settings.webhookUrl(`/plivo/participant?${this.legQuery({ ...input, role: 'SUPERVISOR' })}`),
        callStatusCallbackMethod: 'POST',
      })) as { requestUuid?: string | string[]; calls?: { requestUuid?: string }[] };
      const id = (Array.isArray(res.requestUuid) ? res.requestUuid[0] : res.requestUuid) ?? res.calls?.[0]?.requestUuid;
      return { providerRequestId: id ? String(id) : `mpc-${input.legId}` };
    } catch (err) {
      throw toProviderError(err, 'add supervisor');
    }
  }

  async setSupervisorMode(input: { mpcName: string; participantCallId: string; coach: boolean }): Promise<void> {
    try {
      const participants = (await this.client.multiPartyCalls.listParticipants({ friendlyName: input.mpcName })) as unknown as {
        objects?: { callUuid?: string; memberId?: string | number }[];
      };
      const member = participants.objects?.find((p) => p.callUuid === input.participantCallId);
      if (!member?.memberId) throw new ProviderError('Supervisor is not in the call any more', false);
      await this.client.multiPartyCalls.updateParticipant(member.memberId, { friendlyName: input.mpcName, coachMode: input.coach });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw toProviderError(err, 'update supervisor');
    }
  }

  async getCallDetails(providerCallId: string): Promise<ProviderCallDetails | null> {
    try {
      const cdr = (await this.client.calls.get(providerCallId)) as unknown as Record<string, unknown>;
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
      return {
        providerCallId,
        billSeconds: num(cdr.billDuration ?? cdr.billedDuration),
        durationSeconds: num(cdr.callDuration),
        costMicros: decimalToMicros(cdr.totalAmount as string | undefined),
        currency: this.settings.costCurrency,
        hangupCause: (cdr.hangupCauseName as string) ?? null,
        hangupSource: (cdr.hangupSource as string) ?? null,
        answered: !!cdr.answerTime,
      };
    } catch (err) {
      const pe = toProviderError(err, 'CDR lookup');
      if (/HTTP 404/.test(pe.message)) return null;
      throw pe;
    }
  }

  /**
   * Stream a recording through the API so browsers never see the provider URL. Uses HTTP Basic
   * auth, which is required once "HTTP auth on recordings" is enabled in the Plivo console.
   */
  async fetchRecording(rec: { providerRecordingId: string; providerUrl: string | null }): Promise<{ body: Readable; contentType: string; contentLength?: number }> {
    let url = rec.providerUrl;
    if (!url) {
      const r = (await this.client.recordings.get(rec.providerRecordingId)) as unknown as { recordingUrl?: string };
      url = r.recordingUrl ?? null;
    }
    if (!url || !/^https:\/\/[a-z0-9.-]*plivo\.com\//i.test(url)) throw Errors.notFound('Recording');
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.creds.authId}:${this.creds.authToken}`).toString('base64')}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok || !res.body) throw new ProviderError(`Recording download failed (HTTP ${res.status})`, res.status >= 500);
    const len = res.headers.get('content-length');
    return {
      body: Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
      contentType: res.headers.get('content-type') ?? 'audio/mpeg',
      contentLength: len ? Number(len) : undefined,
    };
  }

  async deleteRecording(providerRecordingId: string): Promise<void> {
    try {
      await this.client.recordings.delete(providerRecordingId);
    } catch (err) {
      const pe = toProviderError(err, 'recording delete');
      if (/HTTP 404/.test(pe.message)) return;
      throw pe;
    }
  }

  /** Receive-only JWT from Plivo's token API (locally signed JWTs are rejected by Plivo SIP). */
  async createBrowserToken(identity: string, ttlSeconds: number): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000);
    try {
      const res = await this.client.token.create(this.creds.authId, {
        sub: identity,
        nbf: now - 30,
        exp: now + ttlSeconds,
        incoming_allow: true,
        outgoing_allow: false,
      });
      if (!res.token) throw new ProviderError('Plivo returned no token', true);
      return { token: res.token, expiresAt: new Date((now + ttlSeconds) * 1000) };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw toProviderError(err, 'token create');
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const account = (await this.client.accounts.get()) as unknown as { name?: string; accountType?: string };
      return { ok: true, message: `Connected to Plivo account${account.name ? ` "${account.name}"` : ''}. No call was placed.` };
    } catch (err) {
      const pe = toProviderError(err, 'account lookup');
      this.logger.warn(pe.message);
      return { ok: false, message: pe.message };
    }
  }

  /** Answer XML for a leg: agents and customers join the same MultiPartyCall. */
  static answerXml(input: {
    role: 'agent' | 'customer' | 'supervisor';
    mpcName: string;
    statusCallbackUrl: string;
    recording: { enabled: boolean; callbackUrl: string; notice: string | null };
    maxDurationSeconds: number;
  }): string {
    const response = plivo.Response();
    if (input.role === 'customer' && input.recording.enabled && input.recording.notice) {
      response.addSpeak(input.recording.notice, { language: 'en-US', voice: 'WOMAN' });
    }
    const attrs: Record<string, unknown> = {
      role: input.role === 'agent' ? 'Agent' : input.role === 'customer' ? 'Customer' : 'Supervisor',
      maxDuration: input.maxDurationSeconds,
      startMpcOnEnter: input.role !== 'supervisor',
      endMpcOnExit: input.role !== 'supervisor',
      stayAlone: input.role === 'agent',
      enterSound: 'none',
      exitSound: 'none',
      statusCallbackUrl: input.statusCallbackUrl,
      statusCallbackMethod: 'POST',
      statusCallbackEvents: 'mpc-state-changes,participant-state-changes',
    };
    if (input.role === 'agent' && input.recording.enabled) {
      attrs.record = true;
      attrs.recordFileFormat = 'mp3';
      attrs.recordingCallbackUrl = input.recording.callbackUrl;
      attrs.recordingCallbackMethod = 'POST';
    }
    response.addMultiPartyCall(input.mpcName, attrs);
    return response.toXML();
  }

  static hangupXml(reason = 'rejected'): string {
    const response = plivo.Response();
    response.addHangup({ reason });
    return response.toXML();
  }
}
