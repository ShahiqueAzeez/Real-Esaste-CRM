import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface WhatsAppSendInput {
  toE164: string;
  templateName: string;
  language: string;
  bodyParams: string[];
}

export interface WhatsAppClient {
  readonly simulated: boolean;
  sendTemplate(input: WhatsAppSendInput): Promise<{ messageId: string }>;
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

/** WhatsApp Business Platform Cloud API (Graph API). Credentials stay server-side. */
export class CloudApiClient implements WhatsAppClient {
  readonly simulated = false;
  constructor(
    private readonly cfg: { baseUrl: string; version: string; phoneNumberId: string; accessToken: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendTemplate(input: WhatsAppSendInput): Promise<{ messageId: string }> {
    const url = `${this.cfg.baseUrl}/${this.cfg.version}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: input.toE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.language },
        components: input.bodyParams.length ? [{ type: 'body', parameters: input.bodyParams.map((text) => ({ type: 'text', text: text.slice(0, 1024) })) }] : [],
      },
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new WhatsAppError(`Network error: ${(err as Error).message}`, null, true);
    }
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number; error_subcode?: number } };
    if (!res.ok || !json.messages?.[0]?.id) {
      const code = json.error?.code != null ? String(json.error.code) : null;
      throw new WhatsAppError(json.error?.message ?? `HTTP ${res.status}`, code, res.status >= 500 || res.status === 429);
    }
    return { messageId: json.messages[0].id };
  }
}

/** Development stand-in: nothing is sent; messages are stored with is_simulated = true. */
export class MockWhatsAppClient implements WhatsAppClient {
  readonly simulated = true;
  async sendTemplate(): Promise<{ messageId: string }> {
    return { messageId: `mock-wamid-${randomUUID()}` };
  }
}

/** Meta signs webhook payloads: X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>. */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice('sha256='.length));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'opt out', 'optout', 'stop all', 'cancel', 'end', 'quit'];

export function isOptOut(text: string | undefined | null): boolean {
  const t = (text ?? '').trim().toLowerCase();
  return OPT_OUT_KEYWORDS.includes(t);
}
