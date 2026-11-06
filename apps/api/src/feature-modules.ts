import { CallbacksModule } from './modules/callbacks/callbacks.module';
import { CallsModule } from './modules/calls/calls.module';
import { ComplianceModule } from './modules/compliance/compliance.controller';
import { ImportsModule } from './modules/imports/imports.controller';
import { LeadsModule } from './modules/leads/leads.controller';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrgModule } from './modules/org/org.controller';
import { RealtimeGatewayModule } from './modules/realtime/realtime.module';
import { UsersModule } from './modules/users/users.controller';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';

/** Feature modules with HTTP controllers, registered by the API process. */
export const FEATURE_MODULES = [
  OrgModule,
  UsersModule,
  ComplianceModule,
  LeadsModule,
  ImportsModule,
  CallsModule,
  CallbacksModule,
  NotificationsModule,
  WhatsAppModule,
  RealtimeGatewayModule,
];
