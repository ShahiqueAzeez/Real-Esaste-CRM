import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { CryptoModule } from './infra/crypto/crypto.service';
import { JobsModule } from './infra/jobs/jobs.module';
import { loggerParams } from './infra/logging/logging';
import { MailModule } from './infra/mail/mail.service';
import { PrismaModule } from './infra/prisma/prisma.service';
import { RealtimeModule } from './infra/realtime/realtime.service';
import { RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.service';
import { AuditModule } from './modules/audit/audit.service';
import { ProvisioningModule } from './modules/tenancy/provisioning.service';
import { OrgCoreModule } from './modules/org/org-core.service';
import { ComplianceCoreModule } from './modules/compliance/compliance.service';
import { TelephonyCoreModule } from './modules/telephony/registry.service';
import { CallsCoreModule } from './modules/calls/calls.module';
import { CallbacksCoreModule } from './modules/callbacks/callbacks.module';
import { WhatsAppCoreModule } from './modules/whatsapp/whatsapp.module';

/** Infrastructure shared by the API and worker processes. */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({ inject: [AppConfig], useFactory: (config: AppConfig) => loggerParams(config.env) }),
    PrismaModule,
    RedisModule,
    JobsModule,
    RealtimeModule,
    CryptoModule,
    MailModule,
    StorageModule,
    AuditModule,
    ProvisioningModule,
    OrgCoreModule,
    ComplianceCoreModule,
    TelephonyCoreModule,
    CallsCoreModule,
    CallbacksCoreModule,
    WhatsAppCoreModule,
  ],
})
export class CoreModule {}
