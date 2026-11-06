import { assertTenantScoped, TenantScopeViolation, whereHasTenant } from './tenant-guard';

describe('tenant guard', () => {
  const T = 'b44c089c-1c8b-445a-8c32-c77a287b485c';

  it('accepts direct, compound and AND-nested tenant constraints', () => {
    expect(whereHasTenant({ tenantId: T })).toBe(true);
    expect(whereHasTenant({ tenantId: { equals: T } })).toBe(true);
    expect(whereHasTenant({ tenantId_phoneE164: { tenantId: T, phoneE164: '+91' } })).toBe(true);
    expect(whereHasTenant({ AND: [{ id: 'x' }, { tenantId: T }] })).toBe(true);
    expect(whereHasTenant({ id: 'x', tenantId: T })).toBe(true);
  });

  it('rejects missing, empty or OR-only tenant constraints', () => {
    expect(whereHasTenant({ id: 'x' })).toBe(false);
    expect(whereHasTenant({ tenantId: '' })).toBe(false);
    expect(whereHasTenant({ OR: [{ tenantId: T }, { id: 'x' }] })).toBe(false);
    expect(whereHasTenant({ queueId_membershipId: { queueId: 'q', membershipId: 'm' } })).toBe(false);
    expect(whereHasTenant(undefined)).toBe(false);
  });

  it('throws for unscoped reads, updates and creates on tenant models', () => {
    expect(() => assertTenantScoped('Lead', 'findMany', { where: { status: 'NEW' } })).toThrow(TenantScopeViolation);
    expect(() => assertTenantScoped('Call', 'update', { where: { id: 'c' }, data: {} })).toThrow(TenantScopeViolation);
    expect(() => assertTenantScoped('Lead', 'create', { data: { fullName: 'x' } })).toThrow(TenantScopeViolation);
    expect(() => assertTenantScoped('Lead', 'createMany', { data: [{ tenantId: T }, { fullName: 'y' }] })).toThrow(TenantScopeViolation);
    expect(() => assertTenantScoped('QueueItem', 'upsert', { where: { leadId: 'l' }, create: { tenantId: T } })).toThrow(TenantScopeViolation);
  });

  it('allows scoped operations and ignores global models', () => {
    expect(() => assertTenantScoped('Lead', 'findMany', { where: { tenantId: T } })).not.toThrow();
    expect(() => assertTenantScoped('Lead', 'create', { data: { tenantId: T, fullName: 'x' } })).not.toThrow();
    expect(() => assertTenantScoped('User', 'findMany', {})).not.toThrow();
    expect(() => assertTenantScoped('Plan', 'findMany', {})).not.toThrow();
  });
});
