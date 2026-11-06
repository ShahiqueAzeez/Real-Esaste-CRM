import type { PrismaClient } from '@prisma/client';

/**
 * The example subscription plans from the product brief. Prices are in paise (minor units) and
 * every field stays editable under Platform > Plans; these are starting points, not commitments.
 */
export const EXAMPLE_PLANS = [
  { code: 'starter', name: 'Starter', monthly: 7_999_00n, annual: 79_990_00n, maxAgents: 5, imports: 10_000, concurrent: 5, features: { recording: false, whatsapp: false, coaching: false, advancedReports: false }, sortOrder: 1 },
  { code: 'professional', name: 'Professional', monthly: 14_999_00n, annual: 149_990_00n, maxAgents: 15, imports: 50_000, concurrent: 15, features: { recording: true, whatsapp: true, coaching: true, advancedReports: false }, sortOrder: 2 },
  { code: 'business', name: 'Business', monthly: 24_999_00n, annual: 249_990_00n, maxAgents: 40, imports: 200_000, concurrent: 40, features: { recording: true, whatsapp: true, coaching: true, advancedReports: true }, sortOrder: 3 },
] as const;

/** Create any missing example plans. Existing plans with the same code are never modified. */
export async function ensureExamplePlans(prisma: PrismaClient): Promise<string[]> {
  const created: string[] = [];
  for (const p of EXAMPLE_PLANS) {
    if (await prisma.plan.findUnique({ where: { code: p.code } })) continue;
    await prisma.plan.create({
      data: {
        code: p.code,
        name: p.name,
        monthlyPriceMinor: p.monthly,
        annualPriceMinor: p.annual,
        currency: 'INR',
        maxAgents: p.maxAgents,
        maxLeadImportsPerMonth: p.imports,
        maxConcurrentCalls: p.concurrent,
        features: p.features,
        sortOrder: p.sortOrder,
        description: `Example ${p.name} plan (configurable).`,
      },
    });
    created.push(p.code);
  }
  return created;
}

/** Standalone use on an existing installation: node dist/scripts/example-plans.js */
if (require.main === module) {
  void (async () => {
    const { existsSync } = await import('node:fs');
    if (existsSync('.env') && typeof process.loadEnvFile === 'function' && process.env.NODE_ENV !== 'production') process.loadEnvFile('.env');
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const created = await ensureExamplePlans(prisma);
      console.log(created.length ? `Example plans created: ${created.join(', ')}` : 'Example plans already exist; left unchanged.');
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })();
}
