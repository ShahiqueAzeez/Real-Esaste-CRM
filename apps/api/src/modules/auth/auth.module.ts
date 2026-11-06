import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService, SessionService } from './session.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, PasswordService],
  exports: [AuthService, SessionService, PasswordService],
})
export class AuthModule {}

/** Session services without HTTP controllers (used by the worker process). */
@Global()
@Module({ providers: [SessionService, PasswordService], exports: [SessionService, PasswordService] })
export class SessionModule {}
