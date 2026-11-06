import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Global, Injectable, Module } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { AppConfig } from '../../config/config';
import { redisOptionsFromUrl } from '../redis/redis.module';

export const Q = {
  imports: 'imports',
  dialer: 'dialer',
  callEvents: 'call-events',
  callbacks: 'callbacks',
  whatsapp: 'whatsapp',
  maintenance: 'maintenance',
  simulator: 'simulator',
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];

export interface JobPayloads {
  'imports.validate': { tenantId: string; importId: string };
  'imports.import': { tenantId: string; importId: string };
  'dialer.customer-leg': { tenantId: string; callId: string };
  'dialer.hangup': { tenantId: string; callId: string; reason: string };
  'dialer.fetch-cdr': { tenantId: string; legId: string };
  'call-events.process': { eventId: string };
  'callbacks.reminder': { tenantId: string; callbackId: string };
  'whatsapp.send': { tenantId: string; messageId: string };
  'simulator.step': { tenantId: string; callId: string; legId: string; step: string };
}
export type JobKey = keyof JobPayloads;

const DEFAULTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Typed producer for all background jobs. Job ids make enqueueing idempotent where it matters. */
@Injectable()
export class JobsService {
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    @InjectQueue(Q.imports) imports: Queue,
    @InjectQueue(Q.dialer) dialer: Queue,
    @InjectQueue(Q.callEvents) callEvents: Queue,
    @InjectQueue(Q.callbacks) callbacks: Queue,
    @InjectQueue(Q.whatsapp) whatsapp: Queue,
    @InjectQueue(Q.maintenance) maintenance: Queue,
    @InjectQueue(Q.simulator) simulator: Queue,
  ) {
    this.queues = {
      [Q.imports]: imports,
      [Q.dialer]: dialer,
      [Q.callEvents]: callEvents,
      [Q.callbacks]: callbacks,
      [Q.whatsapp]: whatsapp,
      [Q.maintenance]: maintenance,
      [Q.simulator]: simulator,
    };
  }

  queue(name: QueueName): Queue {
    return this.queues[name];
  }

  async add<K extends JobKey>(key: K, data: JobPayloads[K], opts: JobsOptions = {}): Promise<void> {
    const [queueName, jobName] = key.split('.') as [QueueName, string];
    await this.queues[queueName].add(jobName, data, { ...DEFAULTS, ...opts });
  }
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        connection: redisOptionsFromUrl(config.env.REDIS_URL, { maxRetriesPerRequest: null }),
        prefix: config.isTest ? 'crm-test' : 'crm',
      }),
    }),
    BullModule.registerQueue(...Object.values(Q).map((name) => ({ name }))),
  ],
  providers: [JobsService],
  exports: [JobsService, BullModule],
})
export class JobsModule {}
