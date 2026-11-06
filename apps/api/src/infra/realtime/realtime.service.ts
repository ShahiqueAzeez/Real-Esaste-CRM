import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import type IORedis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export const REALTIME_CHANNEL = 'crm:realtime';

export interface RealtimeEnvelope {
  room: string;
  event: string;
  payload: unknown;
}

export const rooms = {
  tenant: (tenantId: string) => `tenant:${tenantId}`,
  supervisors: (tenantId: string) => `tenant:${tenantId}:supervisors`,
  membership: (membershipId: string) => `membership:${membershipId}`,
};

/**
 * Publishes realtime events through Redis so that the worker and every API instance can reach
 * connected browsers. Delivery is best-effort: clients refetch authoritative state over REST.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger('Realtime');
  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  async publish(room: string, event: string, payload: unknown): Promise<void> {
    try {
      await this.redis.publish(REALTIME_CHANNEL, JSON.stringify({ room, event, payload } satisfies RealtimeEnvelope));
    } catch (err) {
      this.logger.warn(`Realtime publish failed for ${event}: ${(err as Error).message}`);
    }
  }

  toTenant(tenantId: string, event: string, payload: unknown) {
    return this.publish(rooms.tenant(tenantId), event, payload);
  }

  toSupervisors(tenantId: string, event: string, payload: unknown) {
    return this.publish(rooms.supervisors(tenantId), event, payload);
  }

  toMembership(membershipId: string, event: string, payload: unknown) {
    return this.publish(rooms.membership(membershipId), event, payload);
  }
}

@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
