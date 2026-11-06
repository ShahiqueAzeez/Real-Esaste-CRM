import { createHmac } from 'node:crypto';
import { CloudApiClient, isOptOut, verifyMetaSignature, WhatsAppError } from './whatsapp.client';

describe('WhatsApp webhook signature', () => {
  const body = Buffer.from('{"entry":[]}');
  const secret = 'app-secret-value-123';
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts the correct signature and rejects tampering', () => {
    expect(verifyMetaSignature(body, sig, secret)).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"entry":[1]}'), sig, secret)).toBe(false);
    expect(verifyMetaSignature(body, sig, 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(undefined, sig, secret)).toBe(false);
  });

  it('detects opt-out keywords exactly', () => {
    expect(isOptOut(' STOP ')).toBe(true);
    expect(isOptOut('Unsubscribe')).toBe(true);
    expect(isOptOut('please stop calling me at night')).toBe(false);
  });
});

describe('CloudApiClient', () => {
  const cfg = { baseUrl: 'https://graph.example.com', version: 'v23.0', phoneNumberId: '1234567', accessToken: 'token' };

  it('sends a template message and returns the WhatsApp message id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new CloudApiClient(cfg, fake);
    await expect(client.sendTemplate({ toE164: '+919876543210', templateName: 'callback_confirmation', language: 'en', bodyParams: ['Priya', 'Mon 4 PM'] })).resolves.toEqual({ messageId: 'wamid.1' });
    expect(calls[0]!.url).toBe('https://graph.example.com/v23.0/1234567/messages');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'template', template: { name: 'callback_confirmation', language: { code: 'en' } } });
    expect(sent.template.components[0].parameters).toEqual([{ type: 'text', text: 'Priya' }, { type: 'text', text: 'Mon 4 PM' }]);
  });

  it('classifies errors as retryable or permanent', async () => {
    const make = (status: number) => (async () => new Response(JSON.stringify({ error: { message: 'boom', code: 131047 } }), { status })) as unknown as typeof fetch;
    await expect(new CloudApiClient(cfg, make(400)).sendTemplate({ toE164: '+91', templateName: 't', language: 'en', bodyParams: [] })).rejects.toMatchObject({ retryable: false, code: '131047' });
    await expect(new CloudApiClient(cfg, make(503)).sendTemplate({ toE164: '+91', templateName: 't', language: 'en', bodyParams: [] })).rejects.toBeInstanceOf(WhatsAppError);
    await expect(new CloudApiClient(cfg, make(503)).sendTemplate({ toE164: '+91', templateName: 't', language: 'en', bodyParams: [] })).rejects.toMatchObject({ retryable: true });
  });
});
