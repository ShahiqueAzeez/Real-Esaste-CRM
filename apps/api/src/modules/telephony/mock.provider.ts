import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Errors } from '../../common/errors';
import type { JobsService } from '../../infra/jobs/jobs.module';
import type { LegTarget, ProviderCallDetails, StartLegInput, StartLegResult, TelephonyCapabilities, TelephonyProvider } from './provider';

/**
 * Simulated telephony for development, demos and automated tests. No audio is carried and no
 * real call is placed; every call it touches is stored with is_simulated = true and labelled
 * SIMULATED in the UI. Events flow through the same ingestion path as real webhooks.
 *
 * Customer outcome is chosen by the last four digits of the number:
 *   …0000 failed · …1111 busy · …2222 no answer · …3333 answers then hangs up after 8s
 *   anything else answers after ~3s and stays connected until someone hangs up.
 */
export const MOCK_SCENARIOS = {
  '0000': 'failed',
  '1111': 'busy',
  '2222': 'no-answer',
  '3333': 'answer-then-hangup',
} as const;

export type SimStep = 'ringing' | 'answered' | 'busy' | 'no-answer' | 'failed' | 'hangup' | 'cancel';

export class MockProvider implements TelephonyProvider {
  readonly kind = 'MOCK' as const;
  readonly costCurrency = null;
  readonly capabilities: TelephonyCapabilities = {
    browserCalling: true,
    phoneCalling: true,
    coaching: false,
    recording: false,
    costReporting: false,
    simulated: true,
  };

  constructor(
    private readonly jobs: JobsService,
    private readonly timeScale: number,
  ) {}

  callerIds(): string[] {
    return ['+910000000000'];
  }

  defaultCallerId(): string {
    return '+910000000000';
  }

  browserTarget(identity: string): LegTarget {
    return { kind: 'SIP', address: `sip:${identity}@simulated.invalid` };
  }

  private async schedule(input: { tenantId: string; callId: string; legId: string }, step: SimStep, delayMs: number) {
    await this.jobs.add(
      'simulator.step',
      { tenantId: input.tenantId, callId: input.callId, legId: input.legId, step },
      { delay: Math.max(0, Math.round(delayMs * this.timeScale)), jobId: `sim-${input.legId}-${step}`, attempts: 3 },
    );
  }

  async startLeg(input: StartLegInput): Promise<StartLegResult> {
    const providerRequestId = `mock-req-${randomUUID()}`;
    if (input.role === 'AGENT') {
      // Simulates the browser (or agent phone) ringing and auto-answering.
      await this.schedule(input, 'ringing', 300);
      await this.schedule(input, 'answered', 1200);
    } else if (input.role === 'CUSTOMER') {
      const scenario = MOCK_SCENARIOS[input.to.address.slice(-4) as keyof typeof MOCK_SCENARIOS];
      await this.schedule(input, 'ringing', 800);
      if (scenario === 'failed') await this.schedule(input, 'failed', 1500);
      else if (scenario === 'busy') await this.schedule(input, 'busy', 2500);
      else if (scenario === 'no-answer') await this.schedule(input, 'no-answer', 6000);
      else {
        await this.schedule(input, 'answered', 3000);
        if (scenario === 'answer-then-hangup') await this.schedule(input, 'hangup', 11000);
        else await this.schedule(input, 'hangup', Math.min(input.timeLimitSeconds, 900) * 1000); // safety cap
      }
    }
    return { providerRequestId };
  }

  async hangupLeg(leg: { legId: string; callId: string; tenantId: string; answered: boolean }): Promise<void> {
    // A distinct job id per request so an explicit hang-up is never deduplicated against the safety cap.
    await this.jobs.add(
      'simulator.step',
      { tenantId: leg.tenantId, callId: leg.callId, legId: leg.legId, step: leg.answered ? 'hangup' : 'cancel' },
      { jobId: `sim-${leg.legId}-manual-${Date.now()}`, attempts: 3 },
    );
  }

  /** Simulation control used by the agent console in mock mode (clearly labelled in the UI). */
  async forceStep(input: { tenantId: string; callId: string; legId: string }, step: SimStep): Promise<void> {
    await this.jobs.add('simulator.step', { ...input, step }, { jobId: `sim-${input.legId}-force-${step}-${Date.now()}`, attempts: 3 });
  }

  async addSupervisor(): Promise<StartLegResult> {
    throw Errors.featureUnavailable('Live coaching needs the Plivo provider. Simulated calls carry no audio to monitor.');
  }

  async setSupervisorMode(): Promise<void> {
    throw Errors.featureUnavailable('Live coaching needs the Plivo provider.');
  }

  async getCallDetails(): Promise<ProviderCallDetails | null> {
    return null;
  }

  async fetchRecording(): Promise<{ body: Readable; contentType: string }> {
    throw Errors.notFound('Recording');
  }

  async deleteRecording(): Promise<void> {
    return;
  }

  async createBrowserToken(): Promise<{ token: string; expiresAt: Date }> {
    throw Errors.featureUnavailable('Simulated calls do not use browser audio.');
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Simulated provider: no real calls are placed.' };
  }

  /** Simulator helper: readable stream placeholder so callers never get provider media. */
  static emptyStream(): Readable {
    return Readable.from([]);
  }
}
