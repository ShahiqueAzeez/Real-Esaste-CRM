import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/** Socket.IO with credentialed CORS restricted to the configured web origins. */
export class SocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, {
      ...options,
      path: '/socket.io',
      cors: { origin: this.origins, credentials: true },
      serveClient: false,
      pingInterval: 20_000,
      pingTimeout: 20_000,
    });
  }
}
