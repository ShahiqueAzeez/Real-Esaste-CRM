import { Prisma } from '@prisma/client';

/**
 * Tenant-scope guard. Every query on a tenant-owned model through the guarded client must constrain
 * `tenantId` (directly, in a compound unique key, or inside an AND). Creates must set `tenantId`.
 * Violations throw immediately: this is a programming error and must fail closed.
 * Code that legitimately spans tenants (webhook resolution, maintenance sweeps) uses the explicit
 * `system` client in PrismaService.
 */
export const TENANT_MODELS = new Set<string>([
  'Membership',
  'Team',
  'TeamSupervisor',
  'Invitation',
  'AgentState',
  'AgentStatusHistory',
  'Lead',
  'LeadNote',
  'LeadActivity',
  'LeadAssignment',
  'ConsentRecord',
  'SuppressionEntry',
  'LeadImportJob',
  'Queue',
  'QueueMember',
  'QueueItem',
  'Call',
  'CallLeg',
  'CallEvent',
  'OutcomeDefinition',
  'CallOutcome',
  'Callback',
  'Recording',
  'WhatsAppTemplate',
  'WhatsAppMessage',
  'ProviderConfig',
  'Subscription',
  'BillingLedgerEntry',
  'UsageLedgerEntry',
  'Notification',
]);

const WHERE_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

export class TenantScopeViolation extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant scope violation: ${model}.${operation} must be constrained by tenantId`);
    this.name = 'TenantScopeViolation';
  }
}

function isTenantCondition(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return typeof v.equals === 'string' || (Array.isArray(v.in) && v.in.length > 0);
  }
  return false;
}

export function whereHasTenant(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  const w = where as Record<string, unknown>;
  if ('tenantId' in w && isTenantCondition(w.tenantId)) return true;
  for (const [key, value] of Object.entries(w)) {
    if (key === 'AND') {
      const parts = Array.isArray(value) ? value : [value];
      if (parts.some((p) => whereHasTenant(p))) return true;
    } else if (key.includes('_') && value && typeof value === 'object' && !Array.isArray(value)) {
      // Compound unique selector such as tenantId_phoneE164.
      if (key.split('_').includes('tenantId') && isTenantCondition((value as Record<string, unknown>).tenantId)) return true;
    }
  }
  return false;
}

function dataHasTenant(data: unknown): boolean {
  if (Array.isArray(data)) return data.every((d) => dataHasTenant(d)); // empty batches write nothing
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (typeof d.tenantId === 'string' && d.tenantId.length > 0) || (!!d.tenant && typeof d.tenant === 'object');
}

export function assertTenantScoped(model: string, operation: string, args: Record<string, unknown> | undefined): void {
  if (!TENANT_MODELS.has(model)) return;
  const a = args ?? {};
  if (WHERE_OPERATIONS.has(operation)) {
    if (!whereHasTenant(a.where)) throw new TenantScopeViolation(model, operation);
  } else if (CREATE_OPERATIONS.has(operation)) {
    if (!dataHasTenant(a.data)) throw new TenantScopeViolation(model, operation);
  } else if (operation === 'upsert') {
    if (!whereHasTenant(a.where) || !dataHasTenant(a.create)) throw new TenantScopeViolation(model, operation);
  }
}

export const tenantGuardExtension = Prisma.defineExtension({
  name: 'tenant-guard',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        assertTenantScoped(model, operation, args as Record<string, unknown>);
        return query(args);
      },
    },
  },
});
