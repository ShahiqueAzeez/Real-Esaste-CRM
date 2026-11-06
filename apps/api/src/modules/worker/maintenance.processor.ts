import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfig } from '../../config/config';
import { Q, type JobPayloads } from '../../infra/jobs/jobs.module';
import { CallbacksService } from '../callbacks/callbacks.module';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

@Processor(Q.maintenance, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger('MaintenanceJob');
  constructor(private readonly maintenance: MaintenanceService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'stale-agents':
        return this.maintenance.staleAgents();
      case 'stuck-calls':
        return this.maintenance.stuckCalls();
      case 'orphan-queue-items':
        return this.maintenance.orphanQueueItems();
      case 'pending-events':
        return this.maintenance.pendingEvents();
      case 'retention':
        return this.maintenance.retention();
      case 'subscriptions':
        return this.maintenance.subscriptions();
      default:
        this.logger.warn(`Unknown maintenance job ${job.name}`);
        return null;
    }
  }
}

@Processor(Q.callbacks, { concurrency: 5 })
export class CallbacksProcessor extends WorkerHost {
  constructor(private readonly callbacks: CallbacksService) {
    super();
  }

  async process(job: Job<JobPayloads['callbacks.reminder']>): Promise<void> {
    await this.callbacks.remind(job.data.tenantId, job.data.callbackId);
  }
}

@Processor(Q.whatsapp, { concurrency: 5 })
export class WhatsAppProcessor extends WorkerHost {
  constructor(private readonly wa: WhatsAppService) {
    super();
  }

  async process(job: Job<JobPayloads['whatsapp.send']>): Promise<void> {
    try {
      await this.wa.deliver(job.data.tenantId, job.data.messageId);
    } catch (err) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) await this.wa.markFailedAfterRetries(job.data.messageId, (err as Error).message);
      throw err;
    }
  }
}

/** Registers repeatable maintenance jobs (BullMQ job schedulers are idempotent upserts). */
@Injectable()
export class SchedulerRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger('Schedulers');
  constructor(
    @InjectQueue(Q.maintenance) private readonly queue: Queue,
    private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.env.DISABLE_SCHEDULERS) return;
    const every: [string, number][] = [
      ['stale-agents', 30_000],
      ['stuck-calls', 60_000],
      ['orphan-queue-items', 120_000],
      ['pending-events', 60_000],
      ['subscriptions', 3600_000],
      ['retention', 6 * 3600_000],
    ];
    for (const [name, ms] of every) {
      await this.queue.upsertJobScheduler(name, { every: ms }, { name, data: {}, opts: { removeOnComplete: 100, removeOnFail: 500 } });
    }
    this.logger.log(`Registered ${every.length} maintenance schedules`);
  }
}
