import { Controller, Delete, Get, HttpCode, Module, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { inviteMemberSchema, teamSchema, updateMemberSchema } from '@crm/shared';
import type { z } from 'zod';
import { Ctx, RequirePermissions, type RequestContext } from '../../common/auth-context';
import { UuidParam, ZBody } from '../../common/pipes/zod';
import { UsersService } from './users.service';

@ApiTags('members')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('members')
  @RequirePermissions('users:read')
  list(@Ctx() ctx: RequestContext) {
    return this.users.listMembers(ctx);
  }

  @Get('members/:id')
  @RequirePermissions('users:read')
  get(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.users.getMember(ctx, id);
  }

  @Patch('members/:id')
  @RequirePermissions('users:manage')
  update(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(updateMemberSchema) body: z.output<typeof updateMemberSchema>) {
    return this.users.updateMember(ctx, id, body);
  }

  @Post('members/:id/reset-link')
  @RequirePermissions('users:manage')
  resetLink(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.users.resetLink(ctx, id);
  }

  @Get('invitations')
  @RequirePermissions('users:manage')
  invitations(@Ctx() ctx: RequestContext) {
    return this.users.listInvitations(ctx);
  }

  @Post('invitations')
  @RequirePermissions('users:manage')
  invite(@Ctx() ctx: RequestContext, @ZBody(inviteMemberSchema) body: z.output<typeof inviteMemberSchema>) {
    return this.users.invite(ctx, body);
  }

  @Post('invitations/:id/revoke')
  @RequirePermissions('users:manage')
  @HttpCode(204)
  revoke(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.users.revokeInvitation(ctx, id);
  }

  @Post('invitations/:id/resend')
  @RequirePermissions('users:manage')
  resend(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.users.resendInvitation(ctx, id);
  }

  @Get('teams')
  @RequirePermissions('users:read')
  teams(@Ctx() ctx: RequestContext) {
    return this.users.listTeams(ctx);
  }

  @Post('teams')
  @RequirePermissions('teams:manage')
  createTeam(@Ctx() ctx: RequestContext, @ZBody(teamSchema) body: z.output<typeof teamSchema>) {
    return this.users.saveTeam(ctx, body);
  }

  @Patch('teams/:id')
  @RequirePermissions('teams:manage')
  updateTeam(@Ctx() ctx: RequestContext, @UuidParam('id') id: string, @ZBody(teamSchema) body: z.output<typeof teamSchema>) {
    return this.users.saveTeam(ctx, body, id);
  }

  @Delete('teams/:id')
  @RequirePermissions('teams:manage')
  @HttpCode(204)
  deleteTeam(@Ctx() ctx: RequestContext, @UuidParam('id') id: string) {
    return this.users.deleteTeam(ctx, id);
  }
}

@Module({ controllers: [UsersController], providers: [UsersService], exports: [UsersService] })
export class UsersModule {}
