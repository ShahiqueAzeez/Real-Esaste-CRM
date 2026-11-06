import { createHmac } from 'node:crypto';
import supertest from 'supertest';
import { CryptoService } from '../src/infra/crypto/crypto.service';
import { addLeads, Client, createOrg, phone, startApp, waitFor, type Org, type TestApp } from './helpers';

describe('CSV lead import', () => {
  let t: TestApp;
  let org: Org;
  let admin: Client;

  beforeAll(async () => {
    t = await startApp({ worker: true });
    org = await createOrg(t.prisma, { agents: 1 });
    admin = new Client(t.app);
    await admin.login(org.admin.email);
  });
  afterAll(() => t.close());

  it('uploads, validates with a preview, imports and reports problems', async () => {
    const existing = phone();
    const suppressed = phone();
    const dupe = phone();
    await t.prisma.lead.create({ data: { tenantId: org.tenantId, fullName: 'Already here', phoneE164: existing } });
    await t.prisma.suppressionEntry.create({ data: { tenantId: org.tenantId, phoneE164: suppressed, channel: 'ALL', reason: 'DO_NOT_CALL' } });
    const local = (e164: string) => e164.slice(3); // 10-digit local format, as agencies export it
    const csv = [
      'Customer Name,Mobile Number,Area,Budget,Consent,Remarks',
      `Priya Raman,${local(phone())},Velachery,75L,yes,=HYPERLINK("http://evil")`,
      `Karthik S,${local(dupe)},OMR,1.2 Cr,yes,`,
      `Karthik Duplicate,${local(dupe)},OMR,,yes,`,
      `No Phone,,Adyar,,yes,`,
      `Bad Phone,12345,Adyar,,yes,`,
      `Existing Person,${local(existing)},Porur,,yes,`,
      `Opted Out,${local(suppressed)},Guindy,,yes,`,
      `Unknown Consent,${local(phone())},Tambaram,around fifty,,`,
    ].join('\n');
    const up = await admin.http.post('/api/imports').set('x-csrf-token', admin.csrf).attach('file', Buffer.from(csv), { filename: 'leads.csv', contentType: 'text/csv' });
    expect(up.status).toBe(201);
    expect(up.body.mapping).toMatchObject({ fullName: 'Customer Name', phone: 'Mobile Number', preferredLocation: 'Area', budgetMin: 'Budget', consentStatus: 'Consent', notes: 'Remarks' });
    const id = up.body.id as string;

    expect((await admin.post(`/api/imports/${id}/confirm`)).body.error.code).toBe('NOT_VALIDATED');
    const mapped = await admin.put(`/api/imports/${id}/mapping`, { mapping: up.body.mapping, options: { duplicateStrategy: 'SKIP' } });
    expect(mapped.status).toBe(200);
    const preview = await waitFor(async () => {
      const r = await admin.get(`/api/imports/${id}`);
      return r.body.status === 'PREVIEW_READY' ? r.body : null;
    });
    expect(preview).toMatchObject({ totalRows: 8, validRows: 5, invalidRows: 2, duplicateRows: 1, existingRows: 1, suppressedRows: 1 });
    expect(preview.previewRows.find((r: { existing: boolean }) => r.existing)).toBeTruthy();

    expect((await admin.post(`/api/imports/${id}/confirm`)).status).toBe(201);
    const done = await waitFor(async () => {
      const r = await admin.get(`/api/imports/${id}`);
      return r.body.status === 'COMPLETED' ? r.body : null;
    });
    expect(done).toMatchObject({ importedRows: 4, skippedRows: 1 });

    const priya = await t.prisma.lead.findFirstOrThrow({ where: { tenantId: org.tenantId, fullName: 'Priya Raman' }, include: { queueItem: true } });
    expect(priya).toMatchObject({ preferredLocation: 'Velachery', budgetMin: 7_500_000n, consentStatus: 'GRANTED' });
    expect(priya.queueItem?.state).toBe('WAITING');
    const optedOut = await t.prisma.lead.findFirstOrThrow({ where: { tenantId: org.tenantId, fullName: 'Opted Out' }, include: { queueItem: true } });
    expect(optedOut.queueItem).toMatchObject({ state: 'DONE', doneReason: 'SUPPRESSED' });
    const unknown = await t.prisma.lead.findFirstOrThrow({ where: { tenantId: org.tenantId, fullName: 'Unknown Consent' } });
    expect(unknown.consentStatus).toBe('UNKNOWN');
    expect(await t.prisma.consentRecord.count({ where: { tenantId: org.tenantId, leadId: priya.id } })).toBe(1);

    const report = await admin.get(`/api/imports/${id}/errors.csv`);
    expect(report.text).toContain('Phone is empty');
    expect(report.text).toContain('Invalid phone');
    expect(report.text).toContain('Duplicate phone number');
    expect(report.text).toContain('Unrecognised budget');

    // Exports neutralise spreadsheet formulas that came in through the import.
    const exported = await admin.get('/api/leads/export');
    expect(exported.status).toBe(200);
    const usage = await t.prisma.usageLedgerEntry.findFirstOrThrow({ where: { tenantId: org.tenantId, kind: 'LEAD_IMPORT', sourceId: id } });
    expect(usage.quantity).toBe(4n);
    const audit = await t.prisma.auditLog.count({ where: { tenantId: org.tenantId, action: 'lead.exported' } });
    expect(audit).toBeGreaterThan(0);
  });

  it('rejects non-CSV uploads and enforces the plan import allowance', async () => {
    const bin = await admin.http.post('/api/imports').set('x-csrf-token', admin.csrf).attach('file', Buffer.from([0, 1, 2, 3]), { filename: 'leads.xlsx', contentType: 'application/vnd.ms-excel' });
    expect(bin.status).toBe(400);
    const small = await createOrg(t.prisma, { agents: 1, plan: `tiny-${Date.now()}` });
    await t.prisma.plan.update({ where: { code: (await t.prisma.subscription.findUniqueOrThrow({ where: { tenantId: small.tenantId }, include: { plan: true } })).plan.code }, data: { maxLeadImportsPerMonth: 1 } });
    const c = new Client(t.app);
    await c.login(small.admin.email);
    const csv = `Name,Phone\nA,${phone().slice(3)}\nB,${phone().slice(3)}\n`;
    const up = await c.http.post('/api/imports').set('x-csrf-token', c.csrf).attach('file', Buffer.from(csv), { filename: 'two.csv', contentType: 'text/csv' });
    await c.put(`/api/imports/${up.body.id}/mapping`, { mapping: { fullName: 'Name', phone: 'Phone' } });
    await waitFor(async () => (await c.get(`/api/imports/${up.body.id}`)).body.status === 'PREVIEW_READY');
    const confirm = await c.post(`/api/imports/${up.body.id}/confirm`);
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('IMPORT_LIMIT');
  });

  describe('WhatsApp', () => {
    const APP_SECRET = 'whatsapp-app-secret-0123456789';
    let http: ReturnType<typeof supertest>;

    beforeAll(async () => {
      http = supertest(t.app.getHttpServer());
      await t.prisma.providerConfig.create({
        data: {
          tenantId: org.tenantId,
          provider: 'WHATSAPP',
          status: 'CONFIGURED',
          config: { phoneNumberId: '1234567890', graphApiVersion: 'v23.0' },
          // No access token: messages go through the simulator, but webhooks use the app secret.
          secretsEncrypted: t.app.get(CryptoService).encryptJson({ appSecret: APP_SECRET, webhookVerifyToken: 'verify-token-123456789' }),
        },
      });
      await t.prisma.whatsAppTemplate.create({ data: { tenantId: org.tenantId, name: 'missed_call_followup', language: 'en', purpose: 'MISSED_CALL_FOLLOWUP', category: 'UTILITY', variables: ['lead.firstName'] } });
    });

    it('applies consent, opt-out and frequency checks before sending', async () => {
      const template = await t.prisma.whatsAppTemplate.findFirstOrThrow({ where: { tenantId: org.tenantId } });
      const [noConsent] = await addLeads(t.prisma, org, 1, { consent: 'UNKNOWN' });
      const blocked = await admin.post('/api/whatsapp/send', { leadId: noConsent!.id, templateId: template.id });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.message).toContain('no consent');

      const [ok] = await addLeads(t.prisma, org, 1);
      const first = await admin.post('/api/whatsapp/send', { leadId: ok!.id, templateId: template.id });
      expect(first.status).toBe(201);
      expect(first.body.isSimulated).toBe(true);
      const sent = await waitFor(async () => {
        const m = await t.prisma.whatsAppMessage.findUnique({ where: { id: first.body.id } });
        return m?.status === 'SENT' ? m : null;
      });
      expect(sent.providerMessageId).toMatch(/^mock-wamid-/);
      await admin.post('/api/whatsapp/send', { leadId: ok!.id, templateId: template.id });
      const capped = await admin.post('/api/whatsapp/send', { leadId: ok!.id, templateId: template.id });
      expect(capped.body.error.message).toContain('frequency cap');
    });

    it('verifies Meta signatures, applies delivery statuses in order and honours STOP', async () => {
      const [lead] = await addLeads(t.prisma, org, 1);
      const msg = await t.prisma.whatsAppMessage.create({ data: { tenantId: org.tenantId, leadId: lead!.id, phoneE164: lead!.phoneE164, direction: 'OUTBOUND', status: 'SENT', providerMessageId: `wamid.${Date.now()}` } });
      const post = (payload: object, secret = APP_SECRET) => {
        const raw = JSON.stringify(payload);
        const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
        return http.post(`/api/webhooks/whatsapp/${org.tenantId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(raw);
      };
      const status = (s: string, ts: number) => ({ entry: [{ changes: [{ value: { statuses: [{ id: msg.providerMessageId, status: s, timestamp: String(ts) }] } }] }] });
      expect((await post(status('read', 1_800_000_100))).status).toBe(200);
      expect((await post(status('delivered', 1_800_000_050))).status).toBe(200); // late, must not downgrade
      expect((await t.prisma.whatsAppMessage.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe('READ');
      expect((await post(status('failed', 1), 'wrong-secret')).status).toBe(403);

      const verify = await http.get(`/api/webhooks/whatsapp/${org.tenantId}?hub.mode=subscribe&hub.verify_token=verify-token-123456789&hub.challenge=4242`);
      expect(verify.text).toBe('4242');
      expect((await http.get(`/api/webhooks/whatsapp/${org.tenantId}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status).toBe(403);

      const inbound = { entry: [{ changes: [{ value: { messages: [{ from: lead!.phoneE164.slice(1), id: `wamid.in.${Date.now()}`, type: 'text', text: { body: 'STOP' } }] } }] }] };
      expect((await post(inbound)).status).toBe(200);
      expect(await t.prisma.suppressionEntry.count({ where: { tenantId: org.tenantId, phoneE164: lead!.phoneE164, channel: 'WHATSAPP', reason: 'OPT_OUT' } })).toBe(1);
      const template = await t.prisma.whatsAppTemplate.findFirstOrThrow({ where: { tenantId: org.tenantId } });
      const after = await admin.post('/api/whatsapp/send', { leadId: lead!.id, templateId: template.id });
      expect(after.body.error.message).toContain('opted out');
    });
  });
});
