/**
 * Create the first platform (SaaS super) administrator. There is no default admin account and no
 * web sign-up for platform admins; this command must be run by an operator with database access.
 *
 *   npm run bootstrap:admin -- --email ops@example.com --name "Ops Admin"
 *   node dist/scripts/bootstrap-admin.js --email ops@example.com --name "Ops Admin"   (production image)
 *
 * The password is read from BOOTSTRAP_ADMIN_PASSWORD or generated and printed once.
 * Refuses to run when a platform admin already exists unless --allow-additional is given.
 * --with-example-plans also creates the example Starter/Professional/Business plans if missing.
 */
import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ensureExamplePlans } from './example-plans';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (existsSync('.env') && typeof process.loadEnvFile === 'function' && process.env.NODE_ENV !== 'production') process.loadEnvFile('.env');
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim() || 'Platform Admin';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: bootstrap-admin --email <email> [--name "<name>"] [--with-example-plans] [--allow-additional]');
  const provided = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (provided && (provided.length < 12 || !/\d/.test(provided) || !/[A-Za-z]/.test(provided))) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters with letters and digits');
  }
  const password = provided ?? `${randomBytes(12).toString('base64url')}7a`;
  const prisma = new PrismaClient();
  try {
    const existingAdmins = await prisma.user.count({ where: { isPlatformAdmin: true } });
    if (existingAdmins > 0 && !process.argv.includes('--allow-additional')) {
      throw new Error('A platform administrator already exists. Use --allow-additional to create another one deliberately.');
    }
    const user = await prisma.user.upsert({
      where: { email },
      create: { email, name, passwordHash: await hash(password), isPlatformAdmin: true, emailVerifiedAt: new Date() },
      update: { isPlatformAdmin: true, passwordHash: await hash(password), failedLoginCount: 0, lockedUntil: null },
    });
    await prisma.auditLog.create({ data: { actorUserId: user.id, action: 'platform.admin_bootstrapped', entityType: 'user', entityId: user.id } });
    console.log(`Platform administrator ready: ${email}`);
    if (process.argv.includes('--with-example-plans')) {
      const created = await ensureExamplePlans(prisma);
      console.log(created.length ? `Example plans created: ${created.join(', ')} (edit them under Platform > Plans)` : 'Example plans already exist; left unchanged.');
    }
    if (!provided) console.log(`Generated password (shown once, store it in a password manager): ${password}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
