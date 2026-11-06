import { randomUUID } from 'node:crypto';
import { addLeads, Client, createOrg, readyAgent, startApp, waitFor, type Org, type TestApp } from './helpers';

async function callStatus(c: Client, id: string) {
  return (await c.get(`/api/calls/${id}`)).body as { status: string; wrapUpStatus: string; talkSeconds: number | null; failureReason: string | null };
}

describe('progressive dialler (simulated provider)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp({ worker: true });
  });
  afterAll(() => t.close());

  it('never gives the same lead to two agents dialling at the same time', async () => {
    const org = await createOrg(t.prisma, { agents: 10 });
    await addLeads(t.prisma, org, 4);
    const clients = await Promise.all(
      org.agents.map(async (a) => {
        const c = new Client(t.app);
        await c.login(a.email);
        await readyAgent(c);
        return c;
      }),
    );
    const results = await Promise.all(clients.map((c) => c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() })));
    const dialing = results.filter((r) => r.body.result === 'DIALING');
    const empty = results.filter((r) => r.body.result === 'NO_LEADS');
    expect(dialing).toHaveLength(4);
    expect(empty).toHaveLength(6);
    const leadIds = dialing.map((r) => r.body.call.lead.id);
    expect(new Set(leadIds).size).toBe(4);
    const inProgress = await t.prisma.queueItem.count({ where: { tenantId: org.tenantId, state: 'IN_PROGRESS' } });
    expect(inProgress).toBe(4);
  });

  it('starts only one call when an agent double-clicks or retries concurrently', async () => {
    const org = await createOrg(t.prisma, { agents: 1 });
    await addLeads(t.prisma, org, 5);
    const c = new Client(t.app);
    await c.login(org.agents[0]!.email);
    await readyAgent(c);
    const key = randomUUID();
    const same = await Promise.all([1, 2, 3].map(() => c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': key })));
    const other = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
    const ids = new Set(same.filter((r) => r.body.call).map((r) => r.body.call.id));
    expect(ids.size).toBe(1);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('CALL_IN_PROGRESS');
    expect(await t.prisma.call.count({ where: { tenantId: org.tenantId } })).toBe(1);
  });

  describe('call lifecycle', () => {
    let org: Org;
    let c: Client;
    beforeAll(async () => {
      org = await createOrg(t.prisma, { agents: 1, settings: { retry: { maxAttempts: 2, delaysMinutes: { NO_ANSWER: [60], BUSY: [30], FAILED: [15] } } } });
      c = new Client(t.app);
      await c.login(org.agents[0]!.email);
    });

    it('connects only after the customer answers, then requires a wrap-up', async () => {
      const [lead] = await addLeads(t.prisma, org, 1);
      await readyAgent(c);
      const dial = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(dial.body.result).toBe('DIALING');
      expect(dial.body.call.isSimulated).toBe(true);
      const id = dial.body.call.id as string;
      const seen = new Set<string>();
      await waitFor(async () => {
        const s = (await callStatus(c, id)).status;
        seen.add(s);
        return s === 'CONNECTED';
      });
      expect(seen.has('COMPLETED')).toBe(false);
      const legs = await t.prisma.callLeg.findMany({ where: { callId: id } });
      expect(legs.find((l) => l.role === 'CUSTOMER')?.everAnswered).toBe(true);

      expect((await c.post(`/api/calls/${id}/outcome`, { outcomeCode: 'NOT_INTERESTED' })).body.error.code).toBe('CALL_ACTIVE');
      expect((await c.post(`/api/calls/${id}/hangup`)).status).toBe(200);
      const done = await waitFor(async () => {
        const s = await callStatus(c, id);
        return s.status === 'COMPLETED' ? s : null;
      });
      expect(done.wrapUpStatus).toBe('PENDING');
      expect(done.talkSeconds).not.toBeNull();
      expect((await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() })).body.error.code).toBe('WRAP_UP_PENDING');
      expect((await c.post(`/api/calls/${id}/outcome`, { outcomeCode: 'INTERESTED' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await c.post(`/api/calls/${id}/outcome`, { outcomeCode: 'CONVERTED', notes: 'Booked a site visit and token amount' })).status).toBe(200);
      expect((await c.post(`/api/calls/${id}/outcome`, { outcomeCode: 'CONVERTED', notes: 'again' })).body.error.code).toBe('ALREADY_WRAPPED');
      const l = await t.prisma.lead.findUniqueOrThrow({ where: { id: lead!.id }, include: { queueItem: true } });
      expect(l.status).toBe('CONVERTED');
      expect(l.attemptCount).toBe(1);
      expect(l.queueItem?.state).toBe('DONE');
      const state = await t.prisma.agentState.findUniqueOrThrow({ where: { membershipId: org.agents[0]!.membershipId } });
      expect(state.status).toBe('READY');
      expect(state.currentCallId).toBeNull();
    });

    it('auto-wraps a busy customer and schedules a retry inside the policy', async () => {
      const [lead] = await addLeads(t.prisma, org, 1, { suffix: '1111' });
      const dial = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(dial.body.call.lead.id).toBe(lead!.id);
      await waitFor(async () => (await callStatus(c, dial.body.call.id)).status === 'BUSY');
      const item = await waitFor(async () => {
        const qi = await t.prisma.queueItem.findUnique({ where: { leadId: lead!.id } });
        return qi?.state === 'WAITING' ? qi : null;
      });
      expect(item.attempts).toBe(1);
      expect(item.availableAt.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
      const outcome = await t.prisma.callOutcome.findUniqueOrThrow({ where: { callId: dial.body.call.id } });
      expect(outcome).toMatchObject({ outcomeCode: 'BUSY', recordedBy: 'SYSTEM' });
    });

    it('stops retrying at the maximum number of attempts', async () => {
      const [lead] = await addLeads(t.prisma, org, 1, { suffix: '2222' });
      await t.prisma.queueItem.update({ where: { leadId: lead!.id }, data: { attempts: 1 } });
      const dial = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(dial.body.call.lead.id).toBe(lead!.id);
      await waitFor(async () => (await callStatus(c, dial.body.call.id)).status === 'NO_ANSWER', 20_000);
      const item = await waitFor(async () => {
        const qi = await t.prisma.queueItem.findUnique({ where: { leadId: lead!.id } });
        return qi?.state === 'DONE' ? qi : null;
      });
      expect(item).toMatchObject({ attempts: 2, doneReason: 'MAX_ATTEMPTS' });
    });

    it('schedules a callback that is dialled first when due', async () => {
      const [cbLead] = await addLeads(t.prisma, org, 1);
      await addLeads(t.prisma, org, 2, { priority: 'URGENT' });
      // Make sure the callback lead is picked for this call.
      await t.prisma.queueItem.update({ where: { leadId: cbLead!.id }, data: { priority: 1000 } });
      const dial = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(dial.body.call.lead.id).toBe(cbLead!.id);
      await waitFor(async () => (await callStatus(c, dial.body.call.id)).status === 'CONNECTED');
      await c.post(`/api/calls/${dial.body.call.id}/hangup`);
      await waitFor(async () => (await callStatus(c, dial.body.call.id)).status === 'COMPLETED');
      const when = new Date(Date.now() + 3600_000);
      expect((await c.post(`/api/calls/${dial.body.call.id}/outcome`, { outcomeCode: 'CALLBACK', callbackAt: when.toISOString(), notes: 'after 6pm' })).status).toBe(200);
      const qi = await t.prisma.queueItem.findUniqueOrThrow({ where: { leadId: cbLead!.id } });
      expect(qi).toMatchObject({ state: 'WAITING', isCallback: true, assignedMembershipId: org.agents[0]!.membershipId });
      expect(qi.availableAt.toISOString()).toBe(when.toISOString());
      const cb = await t.prisma.callback.findFirstOrThrow({ where: { leadId: cbLead!.id } });
      expect(cb.status).toBe('PENDING');
      // When it falls due it outranks the urgent leads.
      await t.prisma.queueItem.update({ where: { id: qi.id }, data: { availableAt: new Date(Date.now() - 1000), priority: 0 } });
      const next = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(next.body.call.lead.id).toBe(cbLead!.id);
      await waitFor(async () => (await callStatus(c, next.body.call.id)).status === 'CONNECTED');
      await c.post(`/api/calls/${next.body.call.id}/hangup`);
      await waitFor(async () => (await callStatus(c, next.body.call.id)).status === 'COMPLETED');
      await c.post(`/api/calls/${next.body.call.id}/outcome`, { outcomeCode: 'NOT_INTERESTED' });
      expect((await t.prisma.callback.findFirstOrThrow({ where: { id: cb.id } })).status).toBe('COMPLETED');
    });

    it('adds “do not call” numbers to the suppression list and never dials them again', async () => {
      const [lead] = await addLeads(t.prisma, org, 1);
      await t.prisma.queueItem.update({ where: { leadId: lead!.id }, data: { priority: 5000 } });
      const dial = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(dial.body.call.lead.id).toBe(lead!.id);
      await waitFor(async () => (await callStatus(c, dial.body.call.id)).status === 'CONNECTED');
      await c.post(`/api/calls/${dial.body.call.id}/hangup`);
      await waitFor(async () => (await callStatus(c, dial.body.call.id)).status === 'COMPLETED');
      await c.post(`/api/calls/${dial.body.call.id}/outcome`, { outcomeCode: 'DO_NOT_CALL' });
      expect(await t.prisma.suppressionEntry.count({ where: { tenantId: org.tenantId, phoneE164: lead!.phoneE164 } })).toBe(1);
      // Even if someone puts it back in the queue, eligibility checks keep it out.
      await t.prisma.queueItem.update({ where: { leadId: lead!.id }, data: { state: 'WAITING', priority: 9999, availableAt: new Date(Date.now() - 1000) } });
      await t.prisma.lead.update({ where: { id: lead!.id }, data: { status: 'NEW' } });
      const again = await c.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(again.body.call?.lead.id).not.toBe(lead!.id);
      if (again.body.call) {
        await waitFor(async () => ['CONNECTED', 'BUSY', 'NO_ANSWER', 'FAILED'].includes((await callStatus(c, again.body.call.id)).status), 20_000);
        await c.post(`/api/calls/${again.body.call.id}/hangup`);
        const s = await waitFor(async () => {
          const st = await callStatus(c, again.body.call.id);
          return ['COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED'].includes(st.status) ? st : null;
        });
        if (s.wrapUpStatus === 'PENDING') await c.post(`/api/calls/${again.body.call.id}/outcome`, { outcomeCode: 'NOT_INTERESTED' });
      }
    });

    it('skips leads without recorded consent when consent is required', async () => {
      const org2 = await createOrg(t.prisma, { agents: 1 });
      await addLeads(t.prisma, org2, 2, { consent: 'UNKNOWN' });
      const c2 = new Client(t.app);
      await c2.login(org2.agents[0]!.email);
      await readyAgent(c2);
      const res = await c2.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(res.body.result).toBe('NO_LEADS');
      expect(await t.prisma.call.count({ where: { tenantId: org2.tenantId } })).toBe(0);
    });

    it('releases the lead without using an attempt when the agent line fails, and pauses the agent', async () => {
      const org3 = await createOrg(t.prisma, { agents: 1 });
      const [lead] = await addLeads(t.prisma, org3, 1);
      const c3 = new Client(t.app);
      await c3.login(org3.agents[0]!.email);
      await readyAgent(c3);
      const dial = await c3.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      // Simulate the browser never answering: end the agent leg before it is answered.
      const agentLeg = await t.prisma.callLeg.findFirstOrThrow({ where: { callId: dial.body.call.id, role: 'AGENT' } });
      const lifecycle = t.worker!.get((await import('../src/modules/calls/call-lifecycle.service')).CallLifecycleService);
      await lifecycle.systemEndLeg({ id: dial.body.call.id, tenantId: org3.tenantId, provider: 'MOCK' }, agentLeg.id, 'NO_ANSWER', 'agent_did_not_answer');
      const s = await waitFor(async () => {
        const st = await callStatus(c3, dial.body.call.id);
        return st.status === 'FAILED' ? st : null;
      });
      expect(s).toMatchObject({ failureReason: 'agent_unreachable', wrapUpStatus: 'NOT_REQUIRED' });
      const qi = await t.prisma.queueItem.findUniqueOrThrow({ where: { leadId: lead!.id } });
      expect(qi).toMatchObject({ state: 'WAITING', attempts: 0 });
      const st = await t.prisma.agentState.findUniqueOrThrow({ where: { membershipId: org3.agents[0]!.membershipId } });
      expect(st.status).toBe('PAUSED');
    });

    it('survives a provider outage: the call fails cleanly, no attempt is used and the agent is told why', async () => {
      const { TelephonyRegistry } = await import('../src/modules/telephony/registry.service');
      const { ProviderError } = await import('../src/modules/telephony/provider');
      const org4 = await createOrg(t.prisma, { agents: 1 });
      const [lead] = await addLeads(t.prisma, org4, 1);
      const c4 = new Client(t.app);
      await c4.login(org4.agents[0]!.email);
      await readyAgent(c4);
      const provider = t.app.get(TelephonyRegistry).mock();
      const spy = jest.spyOn(provider, 'startLeg').mockRejectedValueOnce(new ProviderError('Provider API unavailable (HTTP 503)', true));
      try {
        const dial = await c4.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
        expect(dial.status).toBe(200);
        const s = await waitFor(async () => {
          const st = await callStatus(c4, dial.body.call.id);
          return st.status === 'FAILED' ? st : null;
        });
        expect(s).toMatchObject({ failureReason: 'provider_error', wrapUpStatus: 'NOT_REQUIRED' });
      } finally {
        spy.mockRestore();
      }
      const qi = await t.prisma.queueItem.findUniqueOrThrow({ where: { leadId: lead!.id } });
      expect(qi).toMatchObject({ state: 'WAITING', attempts: 0 });
      expect((await t.prisma.lead.findUniqueOrThrow({ where: { id: lead!.id } })).attemptCount).toBe(0);
      const st = await t.prisma.agentState.findUniqueOrThrow({ where: { membershipId: org4.agents[0]!.membershipId } });
      expect(st.status).toBe('PAUSED');
      expect(st.pauseReason).toMatch(/telephony provider rejected the call/i);
      // The agent can resume and the same lead is offered again once the provider recovers.
      await readyAgent(c4);
      const retry = await c4.post('/api/agent/dial-next', {}, { 'Idempotency-Key': randomUUID() });
      expect(retry.body).toMatchObject({ result: 'DIALING', call: { lead: { id: lead!.id } } });
    });

    it('reports only what is persisted', async () => {
      const admin = new Client(t.app);
      await admin.login(org.admin.email);
      const from = new Date(Date.now() - 86400_000).toISOString();
      const to = new Date(Date.now() + 86400_000).toISOString();
      const overview = (await admin.get(`/api/reports/overview?from=${from}&to=${to}`)).body;
      const dbAttempted = await t.prisma.call.count({ where: { tenantId: org.tenantId, countedAsAttempt: true } });
      const dbAnswered = await t.prisma.call.count({ where: { tenantId: org.tenantId, customerAnsweredAt: { not: null } } });
      expect(overview.calls.attempted).toBe(dbAttempted);
      expect(overview.calls.answered).toBe(dbAnswered);
      expect(overview.calls.simulated).toBe(overview.calls.initiated);
      expect(overview.costs.providerReported).toEqual([]);
      expect(overview.conversions).toBe(1);
      const csv = await admin.get(`/api/reports/calls.csv?from=${from}&to=${to}`);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.split('\r\n')[0]).toContain('Simulated');
    });
  });
});
