import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { SessionModule } from './modules/auth/auth.module';
import { ImportRunner } from './modules/imports/import-runner.service';
import { MaintenanceService } from './modules/maintenance/maintenance.service';
import { CallbacksProcessor, MaintenanceProcessor, SchedulerRegistrar, WhatsAppProcessor } from './modules/worker/maintenance.processor';
import { CallEventsProcessor, DialerProcessor, ImportsProcessor, SimulatorProcessor } from './modules/worker/processors';

/** Background worker: BullMQ processors and repeatable maintenance schedules. No HTTP server. */
@Module({
  imports: [CoreModule, SessionModule],
  providers: [
    ImportRunner,
    MaintenanceService,
    DialerProcessor,
    CallEventsProcessor,
    ImportsProcessor,
    SimulatorProcessor,
    MaintenanceProcessor,
    CallbacksProcessor,
    WhatsAppProcessor,
    SchedulerRegistrar,
  ],
  exports: [ImportRunner, MaintenanceService],
})
export class WorkerModule {}
