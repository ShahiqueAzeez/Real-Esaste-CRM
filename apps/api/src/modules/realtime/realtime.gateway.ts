import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConnectedSocket, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { hasPermission } from '@crm/shared';
import { parse as parseCookie } from 'cookie';
import IORedis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { AppConfig } from '../../config/config';
import { REALTIME_CHANNEL, rooms, type RealtimeEnvelope } from '../../infra/realtime/realtime.service';
import { redisOptionsFromUrl } from '../../infra/redis/redis.module';
import { AgentService } from '../agent/agent.service';
import { SESSION_COOKIE, SessionService } from '../auth/session.service';

interface SocketAuth {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: string;
}

/**
 * Socket.IO gateway. The handshake is authenticated with the same session cookie as REST; sockets
 * join only their own tenant, membership and (for supervisors/admins) the supervisors room.
 * Events published by any process arrive through Redis and are fanned out here.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('RealtimeGateway');
  private subscriber: IORedis | null = null;

  constructor(
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = new IORedis(redisOptionsFromUrl(this.config.env.REDIS_URL, { maxRetriesPerRequest: null }));
    await this.subscriber.subscribe(REALTIME_CHANNEL);
    this.subscriber.on('message', (_channel, message) => {
      try {
        const env = JSON.parse(message) as RealtimeEnvelope;
        this.server?.to(env.room).emit(env.event, env.payload);
      } catch (err) {
        this.logger.warn(`Bad realtime message: ${(err as Error).message}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const cookies = parseCookie(client.handshake.headers.cookie ?? '');
      const origin = client.handshake.headers.origin;
      if (origin && !this.config.env.WEB_ORIGIN.includes(origin) && origin !== new URL(this.config.env.PUBLIC_BASE_URL).origin) throw new Error('origin not allowed');
      const session = await this.sessions.resolve(cookies[SESSION_COOKIE]);
      if (!session?.membership) throw new Error('unauthenticated');
      const m = session.membership;
      const auth: SocketAuth = { userId: session.user.id, tenantId: m.tenantId, membershipId: m.membershipId, role: m.role };
      client.data.auth = auth;
      await client.join([rooms.tenant(m.tenantId), rooms.membership(m.membershipId)]);
      if (hasPermission(m.permissions, 'monitor:view')) await client.join(rooms.supervisors(m.tenantId));
      client.emit('ready', { membershipId: m.membershipId });
    } catch {
      client.emit('unauthorized');
      client.disconnect(true);
    }
  }

  /** Agents send a heartbeat every ~20 s; missing heartbeats move them Offline (maintenance sweep). */
  @SubscribeMessage('agent.heartbeat')
  async heartbeat(@ConnectedSocket() client: Socket): Promise<void> {
    const auth = client.data.auth as SocketAuth | undefined;
    if (auth) await this.agent.heartbeat(auth.tenantId, auth.membershipId);
  }
}
