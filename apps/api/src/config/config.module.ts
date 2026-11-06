import { Global, Module } from '@nestjs/common';
import { AppConfig } from './config';

@Global()
@Module({ providers: [{ provide: AppConfig, useFactory: () => new AppConfig() }], exports: [AppConfig] })
export class ConfigModule {}
