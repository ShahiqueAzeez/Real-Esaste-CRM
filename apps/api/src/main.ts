import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/config';
import { SocketIoAdapter } from './infra/realtime/socket-io.adapter';

/** Apply the production HTTP configuration (also used by integration tests). */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const config = app.get(AppConfig);
  app.set('trust proxy', config.env.TRUST_PROXY);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.env.WEB_ORIGIN, credentials: true });
  app.useWebSocketAdapter(new SocketIoAdapter(app, config.env.WEB_ORIGIN));
  app.enableShutdownHooks();
  return app;
}

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  const config = app.get(AppConfig);
  app.useLogger(app.get(Logger));
  configureApp(app);
  if (config.env.ENABLE_API_DOCS) {
    const doc = new DocumentBuilder()
      .setTitle('Calling CRM API')
      .setDescription('REST API for the multi-tenant calling CRM. Authenticate with the session cookie; send x-csrf-token on writes.')
      .setVersion('0.1.0')
      .addCookieAuth('crm_sid')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
  return app;
}

async function bootstrap() {
  const app = await createApp();
  const config = app.get(AppConfig);
  await app.listen(config.env.PORT, '0.0.0.0');
  app.get(Logger).log(`API listening on :${config.env.PORT}`);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
