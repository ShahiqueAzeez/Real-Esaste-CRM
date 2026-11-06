import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PRIORITY_WEIGHT, tenantSettingsSchema, type MembershipRole } from '@crm/shared';
import { PrismaClient, type Lead } from '@prisma/client';
import supertest from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { addMembershipRecords, createTenantRecords } from '../src/modules/tenancy/provisioning';
import { WorkerModule } from '../src/worker.module';

export const PASSWORD = 'Test-password-123';
let passwordHash: Promise<string> | null = null;

export interface TestApp {
  app: NestExpressApplication;
  worker: INestApplicationContext | null;
  prisma: PrismaClient;
  close(): Promise<void>;
}

export async function startApp(opts: { worker?: boolean } = {}): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: process.env.TEST_DEBUG ? ['error'] : false });
  configureApp(app);
  await app.init();
  const worker = opts.worker ? await NestFactory.createApplicationContext(WorkerModule, { logger: false }) : null;
  if (worker) await worker.init();
  const prisma = new PrismaClient();
  return {
    app,
    worker,
    prisma,
    async close() {
      await worker?.close();
      await app.close();
      await prisma.$disconnect();
    },
  };
}

/** Cookie-jar HTTP client that sends the CSRF token on writes, like the web app. */
export class Client {
  readonly http: supertest.Agent;
  csrf = '';
  constructor(app: NestExpressApplication) {
    this.http = supertest.agent(app.getHttpServer());
  }
  private captureCsrf(res: supertest.Response) {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const c = cookies.find((x) => x.startsWith('crm_csrf='));
    if (c) this.csrf = decodeURIComponent(c.split(';')[0]!.slice('crm_csrf='.length));
    return res;
  }
  async login(email: string, password = PASSWORD) {
    return this.captureCsrf(await this.http.post('/api/auth/login').send({ email, password }));
  }
  get(url: string) {
    return this.http.get(url);
  }
  async post(url: string, body: object = {}, headers: Record<string, string> = {}) {
    let req = this.http.post(url).set('x-csrf-token', this.csrf);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return this.captureCsrf(await req.send(body));
  }
  patch(url: string, body: object = {}) {
    return this.http.patch(url).set('x-csrf-token', this.csrf).send(body);
  }
  put(url: string, body: object = {}) {
    return this.http.put(url).set('x-csrf-token', this.csrf).send(body);
  }
  delete(url: string) {
    return this.http.delete(url).set('x-csrf-token', this.csrf);
  }
}

export async function ensurePlan(prisma: PrismaClient, code = 'test-pro', overrides: Partial<{ maxAgents: number; maxConcurrentCalls: number; maxLeadImportsPerMonth: number; features: Record<string, boolean> }> = {}) {
  return prisma.plan.upsert({
    where: { code },
    create: {
      code,
      name: `Plan ${code}`,
      monthlyPriceMinor: 1_499_900n,
      annualPriceMinor: 14_999_000n,
      maxAgents: overrides.maxAgents ?? 50,
      maxLeadImportsPerMonth: overrides.maxLeadImportsPerMonth ?? 100_000,
      maxConcurrentCalls: overrides.maxConcurrentCalls ?? 50,
      features: overrides.features ?? { recording: true, whatsapp: true, coaching: true, advancedReports: true },
    },
    update: {},
  });
}

export interface Org {
  tenantId: string;
  queueId: string;
  admin: { email: string; membershipId: string };
  supervisor: { email: string; membershipId: string };
  agents: { email: string; membershipId: string; userId: string }[];
}

let slugCounter = 0;
export async function createOrg(prisma: PrismaClient, opts: { agents?: number; plan?: string; settings?: Record<string, unknown>; slug?: string } = {}): Promise<Org> {
  await ensurePlan(prisma, opts.plan ?? 'test-pro');
  passwordHash ??= hash(PASSWORD);
  const pw = await passwordHash;
  const slug = opts.slug ?? `org-${Date.now().toString(36)}-${slugCounter++}`;
  const settings = tenantSettingsSchema.parse({ callingHours: { enabled: false }, ...(opts.settings ?? {}) });
  return prisma.$transaction(async (tx) => {
    const tenant = await createTenantRecords(tx, { name: `Org ${slug}`, slug, timezone: 'Asia/Kolkata', planCode: opts.plan ?? 'test-pro', billingPeriod: 'MONTHLY', trialDays: 30, settings });
    const make = async (email: string, role: MembershipRole) => {
      const user = await tx.user.create({ data: { email, name: email.split('@')[0]!, passwordHash: pw, emailVerifiedAt: new Date() } });
      const m = await addMembershipRecords(tx, { tenantId: tenant.id, userId: user.id, role });
      return { email, membershipId: m.id, userId: user.id };
    };
    const admin = await make(`admin@${slug}.test`, 'ORG_ADMIN');
    const supervisor = await make(`supervisor@${slug}.test`, 'SUPERVISOR');
    const agents = [];
    for (let i = 0; i < (opts.agents ?? 1); i++) agents.push(await make(`agent${i}@${slug}.test`, 'AGENT'));
    const queue = await tx.queue.findFirstOrThrow({ where: { tenantId: tenant.id, isDefault: true } });
    return { tenantId: tenant.id, queueId: queue.id, admin, supervisor, agents };
  });
}

let phoneCounter = 100_000_000 + Math.floor(Math.random() * 400_000_000);
/** A valid Indian mobile number; `suffix` (4 digits) drives the mock scenario (1111 busy, 2222 no answer…). */
export function phone(suffix?: string): string {
  const n = String(phoneCounter++).slice(-9);
  const base = `9${n}`;
  return `+91${suffix ? base.slice(0, 6) + suffix : base}`;
}

export async function addLeads(
  prisma: PrismaClient,
  org: Org,
  count: number,
  opts: { consent?: 'GRANTED' | 'UNKNOWN' | 'REVOKED'; suffix?: string; assignedTo?: string | null; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'; availableAt?: Date } = {},
): Promise<Lead[]> {
  const leads: Lead[] = [];
  for (let i = 0; i < count; i++) {
    const lead = await prisma.lead.create({
      data: {
        tenantId: org.tenantId,
        fullName: `Lead ${i}`,
        phoneE164: phone(opts.suffix),
        consentStatus: opts.consent ?? 'GRANTED',
        consentSource: (opts.consent ?? 'GRANTED') === 'GRANTED' ? 'test fixture' : null,
        priority: opts.priority ?? 'NORMAL',
        assignedMembershipId: opts.assignedTo ?? null,
      },
    });
    await prisma.queueItem.create({
      data: { tenantId: org.tenantId, queueId: org.queueId, leadId: lead.id, priority: PRIORITY_WEIGHT[opts.priority ?? 'NORMAL'], assignedMembershipId: opts.assignedTo ?? null, availableAt: opts.availableAt ?? new Date(Date.now() - 1000) },
    });
    leads.push(lead);
  }
  return leads;
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, intervalMs = 50): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Make an agent ready to dial: device check + Ready. */
export async function readyAgent(client: Client) {
  await client.post('/api/agent/device', { microphone: 'granted', providerRegistered: false });
  const res = await client.post('/api/agent/status', { status: 'READY' });
  if (res.status !== 200) throw new Error(`could not set ready: ${res.status} ${JSON.stringify(res.body)}`);
}
