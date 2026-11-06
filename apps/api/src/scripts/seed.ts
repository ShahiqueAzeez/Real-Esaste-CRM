/**
 * Development seed with SYNTHETIC data only. Creates plans and a demo tenant whose leads carry
 * source = SYNTHETIC_SOURCE; the dialer refuses to send those numbers to a real provider.
 *
 *   npm run db:seed                      (development)
 *   SEED_PASSWORD=... npm run db:seed    (choose the demo users' password)
 */
import { PRIORITY_WEIGHT, tenantSettingsSchema, type LeadPriority } from '@crm/shared';
import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { SYNTHETIC_SOURCE } from '../common/constants';
import { addMembershipRecords, createTenantRecords } from '../modules/tenancy/provisioning';

const PLANS = [
  { code: 'starter', name: 'Starter', monthly: 7_999_00n, annual: 79_990_00n, maxAgents: 5, imports: 10_000, concurrent: 5, features: { recording: false, whatsapp: false, coaching: false, advancedReports: false }, sortOrder: 1 },
  { code: 'professional', name: 'Professional', monthly: 14_999_00n, annual: 149_990_00n, maxAgents: 15, imports: 50_000, concurrent: 15, features: { recording: true, whatsapp: true, coaching: true, advancedReports: false }, sortOrder: 2 },
  { code: 'business', name: 'Business', monthly: 24_999_00n, annual: 249_990_00n, maxAgents: 40, imports: 200_000, concurrent: 40, features: { recording: true, whatsapp: true, coaching: true, advancedReports: true }, sortOrder: 3 },
];

const FIRST = ['Arun', 'Priya', 'Karthik', 'Divya', 'Suresh', 'Lakshmi', 'Vignesh', 'Meena', 'Rajesh', 'Anitha', 'Prakash', 'Revathi', 'Senthil', 'Kavya', 'Bala', 'Nandhini', 'Ganesh', 'Sowmya', 'Hari', 'Deepa'];
const LAST = ['Kumar', 'Raman', 'Subramanian', 'Iyer', 'Natarajan', 'Krishnan', 'Venkatesh', 'Murugan', 'Rao', 'Pillai'];
const AREAS = ['Velachery', 'OMR - Sholinganallur', 'Anna Nagar', 'Adyar', 'Tambaram', 'Porur', 'Medavakkam', 'Perungudi', 'Guindy', 'Pallavaram'];
const INTEREST = ['2 BHK apartment', '3 BHK apartment', 'Independent villa', 'Residential plot', '1 BHK apartment', 'Gated community villa'];

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
    throw new Error('Refusing to seed synthetic data in production (pass --force to override deliberately).');
  }
  if (existsSync('.env') && typeof process.loadEnvFile === 'function' && process.env.NODE_ENV !== 'production') process.loadEnvFile('.env');
  const prisma = new PrismaClient();
  const password = process.env.SEED_PASSWORD ?? `Demo-${randomBytes(6).toString('hex')}-1`;

  for (const p of PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, monthlyPriceMinor: p.monthly, annualPriceMinor: p.annual, currency: 'INR', maxAgents: p.maxAgents, maxLeadImportsPerMonth: p.imports, maxConcurrentCalls: p.concurrent, features: p.features, sortOrder: p.sortOrder, description: `Example ${p.name} plan (configurable).` },
      update: {},
    });
  }

  if (await prisma.tenant.findUnique({ where: { slug: 'demo-realty' } })) {
    console.log('Demo tenant already exists; plans ensured. Nothing else to do.');
    await prisma.$disconnect();
    return;
  }

  const passwordHash = await hash(password);
  const settings = tenantSettingsSchema.parse({
    callingHours: { enabled: false },
    costEstimates: { currency: 'INR', agentLegPerMinuteMinor: 40, customerLegPerMinuteMinor: 60 },
    whatsapp: { sendCallbackConfirmation: true, sendMissedCallFollowup: false },
  });

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await createTenantRecords(tx, { name: 'Demo Realty Chennai', slug: 'demo-realty', timezone: 'Asia/Kolkata', planCode: 'professional', billingPeriod: 'MONTHLY', trialDays: 30, settings });
    const team = await tx.team.create({ data: { tenantId: tenant.id, name: 'South Chennai Team' } });
    const people = [
      { email: 'admin@demo-realty.test', name: 'Asha Admin', role: 'ORG_ADMIN' as const },
      { email: 'supervisor@demo-realty.test', name: 'Sundar Supervisor', role: 'SUPERVISOR' as const },
      { email: 'agent1@demo-realty.test', name: 'Anand Agent', role: 'AGENT' as const },
      { email: 'agent2@demo-realty.test', name: 'Bhavani Agent', role: 'AGENT' as const },
    ];
    const memberships: Record<string, string> = {};
    for (const p of people) {
      const user = await tx.user.create({ data: { email: p.email, name: p.name, passwordHash, emailVerifiedAt: new Date() } });
      const m = await addMembershipRecords(tx, { tenantId: tenant.id, userId: user.id, role: p.role, teamId: p.role === 'AGENT' ? team.id : null });
      memberships[p.email] = m.id;
    }
    await tx.teamSupervisor.create({ data: { tenantId: tenant.id, teamId: team.id, membershipId: memberships['supervisor@demo-realty.test']! } });
    const queue = await tx.queue.findFirstOrThrow({ where: { tenantId: tenant.id, isDefault: true } });

    // 40 synthetic leads. Suffixes drive the simulator: 1111 busy, 2222 no answer, 0000 failed.
    const suffixes = ['1111', '2222', '0000', '3333'];
    for (let i = 0; i < 40; i++) {
      const suffix = i < 4 ? suffixes[i]! : String(4000 + i).padStart(4, '0');
      const phone = `+9198765${String(i % 10)}${suffix}`;
      const priority: LeadPriority = i % 9 === 0 ? 'HIGH' : 'NORMAL';
      const minL = 40 + (i % 8) * 15;
      const lead = await tx.lead.create({
        data: {
          tenantId: tenant.id,
          fullName: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
          phoneE164: phone,
          email: i % 3 === 0 ? `lead${i}@example.com` : null,
          propertyInterest: INTEREST[i % INTEREST.length],
          preferredLocation: AREAS[i % AREAS.length],
          budgetMin: BigInt(minL * 100_000),
          budgetMax: BigInt((minL + 30) * 100_000),
          source: SYNTHETIC_SOURCE,
          priority,
          consentStatus: i % 10 === 9 ? 'UNKNOWN' : 'GRANTED',
          consentSource: i % 10 === 9 ? null : 'Synthetic demo: website enquiry form',
          consentCapturedAt: i % 10 === 9 ? null : new Date(),
          assignedMembershipId: i < 6 ? memberships['agent1@demo-realty.test'] : null,
        },
      });
      await tx.queueItem.create({ data: { tenantId: tenant.id, queueId: queue.id, leadId: lead.id, priority: PRIORITY_WEIGHT[priority], assignedMembershipId: lead.assignedMembershipId } });
      await tx.leadActivity.create({ data: { tenantId: tenant.id, leadId: lead.id, type: 'CREATED', data: { seed: true } } });
    }
    await tx.suppressionEntry.create({ data: { tenantId: tenant.id, phoneE164: '+919876500999', channel: 'ALL', reason: 'DO_NOT_CALL', source: 'seed', note: 'Synthetic example entry' } });
    await tx.whatsAppTemplate.createMany({
      data: [
        { tenantId: tenant.id, name: 'callback_confirmation', language: 'en', purpose: 'CALLBACK_CONFIRMATION', category: 'UTILITY', variables: ['lead.firstName', 'callback.when', 'org.name'] },
        { tenantId: tenant.id, name: 'missed_call_followup', language: 'en', purpose: 'MISSED_CALL_FOLLOWUP', category: 'UTILITY', variables: ['lead.firstName', 'org.name'] },
      ],
    });
    return tenant;
  });

  console.log(`Seeded demo tenant ${result.name} (${result.slug}) with synthetic leads.`);
  console.log('Demo users (development only):');
  for (const e of ['admin', 'supervisor', 'agent1', 'agent2']) console.log(`  ${e}@demo-realty.test`);
  console.log(`Password for all demo users: ${password}`);
  console.log('Create a platform administrator with: npm run bootstrap:admin -- --email you@example.com --name "Your Name"');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
