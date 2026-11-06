import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { isTerminalLeg } from '@crm/shared';
import type { Job } from 'bullmq';
import { Q, type JobPayloads } from '../../infra/jobs/jobs.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CallLifecycleService } from '../calls/call-lifecycle.service';
import { DialerService } from '../calls/dialer.service';
import { ImportRunner } from '../imports/import-runner.service';
import type { SimStep } from '../telephony/mock.provider';
import type { ProviderEvent } from '../telephony/provider';

@Processor(Q.dialer, { concurrency: 20 })
export class DialerProcessor extends WorkerHost {
  constructor(private readonly dialer: DialerService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'customer-leg') {
      const d = job.data as JobPayloads['dialer.customer-leg'];
      await this.dialer.startCustomerLeg(d.tenantId, d.callId);
    } else if (job.name === 'hangup') {
      const d = job.data as JobPayloads['dialer.hangup'];
      await this.dialer.hangupCall(d.tenantId, d.callId);
    } else if (job.name === 'fetch-cdr') {
      const d = job.data as JobPayloads['dialer.fetch-cdr'];
      await this.dialer.fetchCdr(d.tenantId, d.legId);
    }
  }
}

@Processor(Q.callEvents, { concurrency: 10 })
export class CallEventsProcessor extends WorkerHost {
  constructor(private readonly lifecycle: CallLifecycleService) {
    super();
  }

  async process(job: Job<JobPayloads['call-events.process']>): Promise<void> {
    await this.lifecycle.processStored(job.data.eventId);
  }
}

@Processor(Q.imports, { concurrency: 2 })
export class ImportsProcessor extends WorkerHost {
  constructor(private readonly runner: ImportRunner) {
    super();
  }

  async process(job: Job<JobPayloads['imports.validate']>): Promise<void> {
    if (job.name === 'validate') await this.runner.validate(job.data.importId);
    else if (job.name === 'import') await this.runner.runImport(job.data.importId);
  }
}

/** Drives simulated calls (mock provider). Produces the same normalized events as webhooks. */
@Processor(Q.simulator, { concurrency: 20 })
export class SimulatorProcessor extends WorkerHost {
  private readonly logger = new Logger('Simulator');
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: CallLifecycleService,
  ) {
    super();
  }

  async process(job: Job<JobPayloads['simulator.step']>): Promise<void> {
    const { tenantId, callId, legId } = job.data;
    const step = job.data.step as SimStep;
    const leg = await this.prisma.system.callLeg.findUnique({ where: { id: legId } });
    if (!leg || leg.tenantId !== tenantId || leg.provider !== 'MOCK' || isTerminalLeg(leg.status)) return;
    const now = new Date();
    const talked = leg.answeredAt ? Math.max(1, Math.round((now.getTime() - leg.answeredAt.getTime()) / 1000)) : 0;
    const base = { provider: 'MOCK' as const, source: 'simulator', tenantId, callId, legId, occurredAt: now, dedupeKey: `sim:${legId}:${step}`, raw: { step, simulated: true } };
    let evt: ProviderEvent;
    switch (step) {
      case 'ringing':
        evt = { ...base, type: 'LEG_RINGING', providerCallId: `mock-call-${legId}` };
        break;
      case 'answered':
        evt = { ...base, type: 'LEG_ANSWERED', providerCallId: `mock-call-${legId}` };
        break;
      case 'busy':
        evt = { ...base, type: 'LEG_ENDED', endStatus: 'BUSY', hangupCause: 'simulated_busy', billSeconds: 0, durationSeconds: 0 };
        break;
      case 'no-answer':
        evt = { ...base, type: 'LEG_ENDED', endStatus: 'NO_ANSWER', hangupCause: 'simulated_no_answer', billSeconds: 0, durationSeconds: 0 };
        break;
      case 'failed':
        evt = { ...base, type: 'LEG_ENDED', endStatus: 'FAILED', hangupCause: 'simulated_network_failure', billSeconds: 0, durationSeconds: 0 };
        break;
      case 'cancel':
        evt = { ...base, type: 'LEG_ENDED', endStatus: 'CANCELLED', hangupCause: 'simulated_cancel', billSeconds: 0, durationSeconds: 0 };
        break;
      case 'hangup':
      default:
        evt = {
          ...base,
          dedupeKey: `sim:${legId}:end`,
          type: 'LEG_ENDED',
          endStatus: leg.everAnswered ? 'COMPLETED' : 'CANCELLED',
          hangupCause: 'simulated_hangup',
          billSeconds: talked,
          durationSeconds: talked,
        };
    }
    if (evt.type === 'LEG_ENDED') evt.dedupeKey = `sim:${legId}:end`;
    const r = await this.lifecycle.ingest(evt);
    if (r.duplicate) this.logger.debug(`Duplicate simulator step ${step} for leg ${legId}`);
  }
}
