import { Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  acceptInviteSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  selectMembershipSchema,
} from '@crm/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentAuth, Public, type AuthState } from '../../common/auth-context';
import { ZBody } from '../../common/pipes/zod';
import { AuthService } from './auth.service';
import { CSRF_COOKIE, SessionService } from './session.service';

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
const STRICT = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Throttle(STRICT)
  @Post('login')
  @HttpCode(200)
  async login(@ZBody(loginSchema) body: z.output<typeof loginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.login(body.email, body.password, meta(req));
    this.sessions.setCookies(res, s.token, s.csrfToken, s.expiresAt);
    const resolved = await this.sessions.resolve(s.token);
    return this.auth.me(resolved!.user.id, resolved!.membership?.membershipId ?? null);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthState, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(auth.sessionId);
    this.sessions.clearCookies(res);
  }

  @Get('me')
  async me(@CurrentAuth() auth: AuthState, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!req.cookies?.[CSRF_COOKIE]) {
      this.sessions.setCsrfCookie(res, await this.sessions.rotateCsrf(auth.sessionId));
    }
    return this.auth.me(auth.user.id, auth.membership?.membershipId ?? null);
  }

  @Post('select-membership')
  @HttpCode(200)
  async select(@CurrentAuth() auth: AuthState, @ZBody(selectMembershipSchema) body: z.output<typeof selectMembershipSchema>, @Res({ passthrough: true }) res: Response) {
    this.sessions.setCsrfCookie(res, await this.auth.selectMembership(auth.user.id, auth.sessionId, body.membershipId));
    return this.auth.me(auth.user.id, body.membershipId);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentAuth() auth: AuthState, @ZBody(changePasswordSchema) body: z.output<typeof changePasswordSchema>) {
    await this.auth.changePassword(auth.user.id, auth.sessionId, body.currentPassword, body.newPassword);
  }

  @Public()
  @Throttle(STRICT)
  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@ZBody(forgotPasswordSchema) body: z.output<typeof forgotPasswordSchema>) {
    await this.auth.forgotPassword(body.email);
    return { message: 'If an account exists for that email, a reset link has been sent.' };
  }

  @Public()
  @Throttle(STRICT)
  @Post('reset-password')
  @HttpCode(204)
  async reset(@ZBody(resetPasswordSchema) body: z.output<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.password);
  }

  @Post('verify-email/request')
  @HttpCode(202)
  requestVerification(@CurrentAuth() auth: AuthState) {
    return this.auth.requestEmailVerification(auth.user.id);
  }

  @Public()
  @Throttle(STRICT)
  @Post('verify-email/confirm/:token')
  @HttpCode(204)
  async confirmEmail(@Param('token') token: string) {
    await this.auth.confirmEmail(token);
  }

  @Public()
  @Throttle(STRICT)
  @Get('invitations/:token')
  describeInvitation(@Param('token') token: string) {
    return this.auth.describeInvitation(token);
  }

  @Public()
  @Throttle(STRICT)
  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@ZBody(acceptInviteSchema) body: z.output<typeof acceptInviteSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.acceptInvitation(body.token, body.name, body.password, meta(req));
    this.sessions.setCookies(res, s.token, s.csrfToken, s.expiresAt);
    const resolved = await this.sessions.resolve(s.token);
    return this.auth.me(resolved!.user.id, resolved!.membership?.membershipId ?? null);
  }
}
