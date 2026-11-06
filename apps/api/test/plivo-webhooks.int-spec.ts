import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createHmac, randomBytes } from 'node:crypto';
import supertest from 'supertest';
import { CryptoService } from '../src/infra/crypto/crypto.service';
import { addLeads, createOrg, startApp, waitFor, type Org, type TestApp } from './helpers';
import { TEST_ENV } from './setup/test-env';

const AUTH_TOKEN = 'plivo-test-auth-token-0123456789';
const run = randomBytes(4).toString('hex');
const uuid = (name: string) => `${name}-${run}`;

/** Plivo's documented V3 signing scheme (see plivo-events.spec.ts). */
function signV3(url: string, params: Record<string, string>, nonce: string, token = AUTH_TOKEN): string {
  const u = new URL(url);
  const query = [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const keys = Object.keys(params).sort();
  let base = `${u.protocol}//${u.host}${u.pathname}`;
  if (query.length || keys.length) base += `?${query.join('&')}`;
  if (query.length && keys.length) base += '.';
  base += keys.map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', token).update(`${base}.${nonce}`).digest('base64');
}

describe('Plivo webhooks', () => {
  let t: TestApp;
  let org: Org;
  let http: ReturnType<typeof supertest>;

  async function hook(kind: string, ids: { callId: string; legId: string; role: string }, params: Record<string, string>, opts: { token?: string; tamper?: boolean } = {}) {
    const path = `/api/webhooks/plivo/${kind}?callId=${ids.callId}&legId=${ids.legId}&role=${ids.role}`;
    const nonce = randomBytes(10).toString('hex');
    const sig = signV3(`${TEST_ENV.PUBLIC_BASE_URL}${path}`, params, nonce, opts.token);
    const body = opts.tamper ? { ...params, CallStatus: 'busy' } : params;
    return http.post(path).type('form').set('X-Plivo-Signature-V3', sig).set('X-Plivo-Signature-V3-Nonce', nonce).send(body);
  }

  async function plivoCall() {
    const [lead] = await addLeads(t.prisma, org, 1);
    const qi = await t.prisma.queueItem.update({ where: { leadId: lead!.id }, data: { state: 'IN_PROGRESS', reservedByMembershipId: org.agents[0]!.membershipId } });
    const call = await t.prisma.call.create({
      data: { tenantId: org.tenantId, leadId: lead!.id, membershipId: org.agents[0]!.membershipId, queueId: org.queueId, queueItemId: qi.id, provider: 'PLIVO', callingMode: 'BROWSER', fromNumber: '+914412345678', toNumberE164: lead!.phoneE164 },
    });
    const agentLeg = await t.prisma.callLeg.create({ data: { tenantId: org.tenantId, callId: call.id, role: 'AGENT', provider: 'PLIVO', toAddress: 'sip:crm_x@phone.plivo.com', status: 'INITIATED', providerRequestId: `req-${call.id}` } });
    await t.prisma.agentState.update({ where: { membershipId: org.agents[0]!.membershipId }, data: { status: 'DIALING', currentCallId: call.id } });
    return { call, agentLeg, lead: lead! };
  }

  beforeAll(async () => {
    t = await startApp();
    http = supertest(t.app.getHttpServer());
    org = await createOrg(t.prisma, { agents: 1 });
    const crypto = t.app.get(CryptoService);
    await t.prisma.providerConfig.create({
      data: {
        tenantId: org.tenantId,
        provider: 'PLIVO',
        status: 'CONFIGURED',
        config: { authId: 'MAXXXXXXXXXXXXXXXXXX', callerIds: ['+914412345678'], defaultCallerId: '+914412345678', costCurrency: 'USD' },
        secretsEncrypted: crypto.encryptJson({ authToken: AUTH_TOKEN }),
      },
    });
  });
  afterAll(() => t.close());

  it('drives a call through signed callbacks and returns MultiPartyCall XML', async () => {
    const { call, agentLeg } = await plivoCall();
    const a = { callId: call.id, legId: agentLeg.id, role: 'agent' };
    expect((await hook('ring', a, { CallUUID: uuid('agent-uuid'), RequestUUID: agentLeg.providerRequestId!, CallStatus: 'ringing' })).status).toBe(200);
    const answer = await hook('answer', a, { CallUUID: uuid('agent-uuid'), RequestUUID: agentLeg.providerRequestId!, CallStatus: 'in-progress' });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('xml');
    expect(answer.text).toContain('role="Agent"');
    expect(answer.text).toContain(`>call-${call.id}</MultiPartyCall>`);

    // The customer leg row is created once and its dial job is queued.
    const customerLeg = await waitFor(() => t.prisma.callLeg.findFirst({ where: { callId: call.id, role: 'CUSTOMER' } }));
    const dialer = t.app.get<Queue>(getQueueToken('dialer'));
    expect(await dialer.getJob(`cust-${call.id}`)).toBeTruthy();
    expect((await t.prisma.call.findUniqueOrThrow({ where: { id: call.id } })).status).toBe('AGENT_CONNECTED');

    const cust = { callId: call.id, legId: customerLeg.id, role: 'customer' };
    await hook('ring', cust, { CallUUID: uuid('cust-uuid'), RequestUUID: uuid('cust-req'), CallStatus: 'ringing' });
    expect((await t.prisma.call.findUniqueOrThrow({ where: { id: call.id } })).status).toBe('CUSTOMER_RINGING');
    const custAnswer = await hook('answer', cust, { CallUUID: uuid('cust-uuid'), RequestUUID: uuid('cust-req'), CallStatus: 'in-progress' });
    expect(custAnswer.text).toContain('role="Customer"');
    expect((await t.prisma.call.findUniqueOrThrow({ where: { id: call.id } })).status).toBe('CONNECTED');

    // Duplicate delivery of the same answer: same XML, no new event row.
    const before = await t.prisma.callEvent.count({ where: { callId: call.id } });
    expect((await hook('answer', cust, { CallUUID: uuid('cust-uuid'), RequestUUID: uuid('cust-req'), CallStatus: 'in-progress' })).text).toContain('role="Customer"');
    expect(await t.prisma.callEvent.count({ where: { callId: call.id } })).toBe(before);

    const hangup = { CallUUID: uuid('cust-uuid'), RequestUUID: uuid('cust-req'), CallStatus: 'completed', Duration: '95', BillDuration: '120', TotalCost: '0.0144', HangupCauseName: 'NORMAL_CLEARING', HangupSource: 'Callee' };
    expect((await hook('hangup', cust, hangup)).body).toEqual({ ok: true, duplicate: false });
    expect((await hook('hangup', cust, hangup)).body).toEqual({ ok: true, duplicate: true });
    const done = await t.prisma.call.findUniqueOrThrow({ where: { id: call.id }, include: { legs: true } });
    expect(done.status).toBe('COMPLETED');
    expect(done.wrapUpStatus).toBe('PENDING');
    const leg = done.legs.find((l) => l.role === 'CUSTOMER')!;
    expect(leg).toMatchObject({ status: 'COMPLETED', billSeconds: 120, costMicros: 14400n, costSource: 'PROVIDER', costCurrency: 'USD' });
    expect(await t.prisma.usageLedgerEntry.count({ where: { tenantId: org.tenantId, sourceId: leg.id } })).toBe(2);
    expect((await t.prisma.agentState.findUniqueOrThrow({ where: { membershipId: org.agents[0]!.membershipId } })).status).toBe('WRAP_UP');
    const stored = await t.prisma.callEvent.findMany({ where: { callId: call.id } });
    expect(stored.every((e) => e.signatureValid === true && e.processedAt)).toBe(true);
    expect(JSON.stringify(stored.map((e) => e.payload))).not.toMatch(/9198|\+91\d{10}/);
  });

  it('absorbs out-of-order events: a late ring never revives an ended call', async () => {
    await t.prisma.agentState.update({ where: { membershipId: org.agents[0]!.membershipId }, data: { status: 'READY', currentCallId: null } });
    await t.prisma.call.updateMany({ where: { tenantId: org.tenantId, wrapUpStatus: 'PENDING' }, data: { wrapUpStatus: 'DONE' } });
    const { call, agentLeg, lead } = await plivoCall();
    const a = { callId: call.id, legId: agentLeg.id, role: 'agent' };
    await hook('hangup', a, { CallUUID: uuid('agent-2'), CallStatus: 'no-answer', HangupCauseName: 'NO_ANSWER' });
    await hook('ring', a, { CallUUID: uuid('agent-2'), CallStatus: 'ringing' });
    const late = await hook('answer', a, { CallUUID: uuid('agent-2'), CallStatus: 'in-progress' });
    expect(late.text).toContain('<Hangup');
    const c = await t.prisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(c).toMatchObject({ status: 'FAILED', failureReason: 'agent_unreachable', wrapUpStatus: 'NOT_REQUIRED' });
    const qi = await t.prisma.queueItem.findUniqueOrThrow({ where: { leadId: lead.id } });
    expect(qi).toMatchObject({ state: 'WAITING', attempts: 0 });
  });

  it('rejects bad signatures, wrong tokens and mismatched identifiers', async () => {
    const { call, agentLeg } = await plivoCall();
    const a = { callId: call.id, legId: agentLeg.id, role: 'agent' };
    expect((await hook('ring', a, { CallUUID: 'x', CallStatus: 'ringing' }, { tamper: true })).status).toBe(403);
    expect((await hook('ring', a, { CallUUID: 'x', CallStatus: 'ringing' }, { token: 'someone-elses-token-000000' })).status).toBe(403);
    expect((await http.post(`/api/webhooks/plivo/ring?callId=${call.id}&legId=${agentLeg.id}&role=agent`).type('form').send({ CallStatus: 'ringing' })).status).toBe(403);
    expect((await hook('ring', { ...a, role: 'customer' }, { CallUUID: 'x', CallStatus: 'ringing' })).status).toBe(404);
    expect((await hook('ring', { ...a, legId: '00000000-0000-4000-8000-000000000000' }, { CallUUID: 'x', CallStatus: 'ringing' })).status).toBe(404);
    expect((await t.prisma.callLeg.findUniqueOrThrow({ where: { id: agentLeg.id } })).status).toBe('INITIATED');
  });
});
