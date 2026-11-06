import { addLeads, Client, createOrg, PASSWORD, startApp, type Org, type TestApp } from './helpers';

describe('authentication, authorization and tenant isolation', () => {
  let t: TestApp;
  let a: Org;
  let b: Org;
  const runId = Date.now().toString(36);
  const platformEmail = `platform-${runId}@ops.test`;

  beforeAll(async () => {
    t = await startApp();
    a = await createOrg(t.prisma, { agents: 2 });
    b = await createOrg(t.prisma, { agents: 1 });
  });
  afterAll(() => t.close());

  describe('sessions', () => {
    it('logs in, returns the membership and sets HttpOnly session + readable CSRF cookies', async () => {
      const c = new Client(t.app);
      const res = await c.login(a.admin.email);
      expect(res.status).toBe(200);
      expect(res.body.membership.role).toBe('ORG_ADMIN');
      const cookies = ([] as string[]).concat(res.headers['set-cookie']);
      expect(cookies.find((x) => x.startsWith('crm_sid='))).toMatch(/HttpOnly/i);
      expect(cookies.find((x) => x.startsWith('crm_csrf='))).not.toMatch(/HttpOnly/i);
      expect(c.csrf.length).toBeGreaterThan(20);
    });

    it('rejects bad credentials without revealing whether the account exists', async () => {
      const c = new Client(t.app);
      const wrong = await c.login(a.admin.email, 'Wrong-password-1');
      const unknown = await c.login('nobody@nowhere.test', 'Wrong-password-1');
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.error.message).toBe(unknown.body.error.message);
    });

    it('requires the CSRF token on writes', async () => {
      const c = new Client(t.app);
      await c.login(a.admin.email);
      const res = await c.http.post('/api/leads').send({ fullName: 'X', phone: '9876543210' });
      expect(res.status).toBe(403);
      const bad = await c.http.post('/api/leads').set('x-csrf-token', 'forged').send({ fullName: 'X', phone: '9876543210' });
      expect(bad.status).toBe(403);
    });

    it('rejects writes from foreign browser origins', async () => {
      const c = new Client(t.app);
      await c.login(a.admin.email);
      const res = await c.http.post('/api/leads').set('x-csrf-token', c.csrf).set('Origin', 'https://evil.example').send({ fullName: 'X', phone: '9876543211' });
      expect(res.status).toBe(403);
    });

    it('locks the account after repeated failures', async () => {
      const victim = a.agents[1]!.email;
      const c = new Client(t.app);
      for (let i = 0; i < 5; i++) await c.login(victim, `Wrong-password-${i}`);
      const locked = await c.login(victim, PASSWORD);
      expect(locked.status).toBe(429);
      await t.prisma.user.update({ where: { email: victim }, data: { lockedUntil: null, failedLoginCount: 0 } });
    });

    it('logs out and revokes the session', async () => {
      const c = new Client(t.app);
      await c.login(a.supervisor.email);
      expect((await c.post('/api/auth/logout')).status).toBe(204);
      expect((await c.get('/api/auth/me')).status).toBe(401);
    });
  });

  describe('invitations', () => {
    it('lets an admin invite an agent and the agent join with the link (email not configured)', async () => {
      const admin = new Client(t.app);
      await admin.login(a.admin.email);
      const inv = await admin.post('/api/invitations', { email: `new.agent.${runId}@a.test`, role: 'AGENT' });
      expect(inv.status).toBe(201);
      expect(inv.body.emailDelivered).toBe(false);
      const token = String(inv.body.inviteLink).split('/invite/')[1]!;
      const pub = new Client(t.app);
      expect((await pub.get(`/api/auth/invitations/${token}`)).body).toMatchObject({ email: `new.agent.${runId}@a.test`, role: 'AGENT', accountExists: false });
      const joined = await pub.post('/api/auth/invitations/accept', { token, name: 'New Agent', password: 'Agent-password-9' });
      expect(joined.status).toBe(200);
      expect(joined.body.membership.role).toBe('AGENT');
      expect((await pub.post('/api/auth/invitations/accept', { token, name: 'Again', password: 'Agent-password-9' })).status).toBe(400);
    });

    it('requires the existing password when the invited email already has an account', async () => {
      const admin = new Client(t.app);
      await admin.login(b.admin.email);
      const inv = await admin.post('/api/invitations', { email: a.agents[0]!.email, role: 'SUPERVISOR' });
      const token = String(inv.body.inviteLink).split('/invite/')[1]!;
      const pub = new Client(t.app);
      expect((await pub.post('/api/auth/invitations/accept', { token, name: 'x', password: 'Guessing-password-1' })).body.error.code).toBe('WRONG_PASSWORD');
      const ok = await pub.post('/api/auth/invitations/accept', { token, name: 'x', password: PASSWORD });
      expect(ok.status).toBe(200);
      expect(ok.body.memberships).toHaveLength(2);
    });
  });

  describe('tenant isolation', () => {
    it('never returns another tenant’s leads, even by id', async () => {
      const [leadB] = await addLeads(t.prisma, b, 1);
      await addLeads(t.prisma, a, 2);
      const c = new Client(t.app);
      await c.login(a.admin.email);
      const list = await c.get('/api/leads?pageSize=200');
      expect(list.body.items.every((l: { tenantId: string }) => l.tenantId === a.tenantId)).toBe(true);
      expect((await c.get(`/api/leads/${leadB!.id}`)).status).toBe(404);
      expect((await c.patch(`/api/leads/${leadB!.id}`, { fullName: 'Hacked' })).status).toBe(404);
      expect((await c.post('/api/leads/bulk/status', { leadIds: [leadB!.id], status: 'CLOSED' })).body).toMatchObject({ updated: 0, skipped: 1 });
      const fresh = await t.prisma.lead.findUniqueOrThrow({ where: { id: leadB!.id } });
      expect(fresh.fullName).not.toBe('Hacked');
      expect(fresh.status).toBe('NEW');
    });

    it('cannot change members or switch into an organization it does not belong to', async () => {
      const c = new Client(t.app);
      await c.login(a.admin.email);
      expect((await c.patch(`/api/members/${b.agents[0]!.membershipId}`, { status: 'DEACTIVATED' })).status).toBe(404);
      expect((await c.post('/api/auth/select-membership', { membershipId: b.admin.membershipId })).status).toBe(403);
    });

    it('scopes agents to their own leads and masks numbers', async () => {
      const [mine] = await addLeads(t.prisma, a, 1, { assignedTo: a.agents[0]!.membershipId });
      const c = new Client(t.app);
      const login = await c.login(a.agents[0]!.email);
      // This agent also joined org B earlier, so the session must pick an organization first.
      expect(login.body.membership).toBeNull();
      expect((await c.get('/api/leads')).status).toBe(403);
      expect((await c.post('/api/auth/select-membership', { membershipId: a.agents[0]!.membershipId })).status).toBe(200);
      const list = await c.get('/api/leads');
      expect(list.body.items.map((l: { id: string }) => l.id)).toEqual([mine!.id]);
      expect(list.body.items[0].phoneE164).toContain('•');
      expect((await c.get('/api/leads/export')).status).toBe(403);
      expect((await c.get('/api/members')).status).toBe(403);
    });

    it('keeps platform admins out of tenant data and tenant admins out of platform routes', async () => {
      await t.prisma.user.create({ data: { email: platformEmail, name: 'Ops', passwordHash: (await t.prisma.user.findUniqueOrThrow({ where: { email: a.admin.email } })).passwordHash, isPlatformAdmin: true } });
      const p = new Client(t.app);
      await p.login(platformEmail);
      expect((await p.get('/api/platform/tenants')).status).toBe(200);
      expect((await p.get('/api/leads')).status).toBe(403);
      const admin = new Client(t.app);
      await admin.login(a.admin.email);
      expect((await admin.get('/api/platform/tenants')).status).toBe(403);
    });

    it('blocks a suspended organization', async () => {
      const p = new Client(t.app);
      await p.login(platformEmail);
      expect((await p.post(`/api/platform/tenants/${b.tenantId}/status`, { status: 'SUSPENDED', reason: 'test' })).status).toBe(200);
      const c = new Client(t.app);
      const res = await c.login(b.admin.email);
      expect(res.status).toBe(403);
      await p.post(`/api/platform/tenants/${b.tenantId}/status`, { status: 'ACTIVE' });
    });
  });
});
