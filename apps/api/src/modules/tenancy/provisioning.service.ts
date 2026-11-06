import { Global, Injectable, Module } from '@nestjs/common';
import type { MembershipRole } from '@crm/shared';
import { Errors } from '../../common/errors';
import { PrismaService, type Tx } from '../../infra/prisma/prisma.service';
import { addMembershipRecords, createTenantRecords, ProvisioningError, type CreateTenantInput } from './provisioning';

export { newTelephonyIdentity } from './provisioning';

/** Creates tenants and memberships with all of their required companion rows. */
@Injectable()
export class ProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async createTenant(input: CreateTenantInput, tx?: Tx) {
    const run = async (db: Tx) => {
      try {
        return await createTenantRecords(db, input);
      } catch (err) {
        if (err instanceof ProvisioningError) {
          throw err.code === 'SLUG_TAKEN' ? Errors.conflict(err.code, err.message) : Errors.badRequest(err.code, err.message);
        }
        throw err;
      }
    };
    return tx ? run(tx) : this.prisma.system.$transaction(run);
  }

  addMembership(tx: Tx, input: { tenantId: string; userId: string; role: MembershipRole; teamId?: string | null }) {
    return addMembershipRecords(tx, input);
  }
}

@Global()
@Module({ providers: [ProvisioningService], exports: [ProvisioningService] })
export class ProvisioningModule {}
