import { Global, Injectable, Module } from '@nestjs/common';
import { AppConfig } from '../../config/config';
import { Errors } from '../../common/errors';
import { CryptoService } from '../../infra/crypto/crypto.service';
import { JobsService } from '../../infra/jobs/jobs.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { MockProvider } from './mock.provider';
import { PlivoProvider } from './plivo.provider';
import type { TelephonyProvider } from './provider';

export interface PlivoTenantConfig {
  authId: string;
  callerIds: string[];
  defaultCallerId: string;
  costCurrency?: string;
}

export type TelephonySource = 'tenant' | 'platform' | 'simulated' | 'none';

/** Resolves the telephony provider for a tenant: own Plivo account → platform Plivo → simulator. */
@Injectable()
export class TelephonyRegistry {
  private readonly cache = new Map<string, { key: string; provider: TelephonyProvider; source: TelephonySource; at: number }>();
  private mockProvider: MockProvider | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
    private readonly jobs: JobsService,
  ) {}

  mock(): MockProvider {
    this.mockProvider ??= new MockProvider(this.jobs, this.config.env.MOCK_TIME_SCALE);
    return this.mockProvider;
  }

  private platformPlivoConfigured(): boolean {
    const e = this.config.env;
    return e.TELEPHONY_DEFAULT_PROVIDER === 'plivo' && !!e.PLIVO_AUTH_ID && !!e.PLIVO_AUTH_TOKEN;
  }

  private plivoSettings(callerIds: string[], defaultCallerId: string | null, costCurrency: string) {
    return {
      callerIds,
      defaultCallerId,
      costCurrency,
      sipUriTemplate: this.config.env.PLIVO_BROWSER_SIP_URI_TEMPLATE,
      timeoutMs: this.config.env.PLIVO_API_TIMEOUT_MS,
      webhookUrl: (path: string) => this.config.webhookUrl(path),
    };
  }

  async resolve(tenantId: string): Promise<{ provider: TelephonyProvider | null; source: TelephonySource; authTokens: string[] }> {
    const cfg = await this.prisma.system.providerConfig.findUnique({ where: { tenantId_provider: { tenantId, provider: 'PLIVO' } } });
    const e = this.config.env;
    if (cfg && cfg.enabled && cfg.secretsEncrypted && cfg.status !== 'DISABLED') {
      const key = `${cfg.id}:${cfg.updatedAt.getTime()}`;
      const secrets = this.crypto.decryptJson<{ authToken: string }>(cfg.secretsEncrypted);
      const cached = this.cache.get(tenantId);
      if (cached && cached.key === key && Date.now() - cached.at < 300_000) return { provider: cached.provider, source: 'tenant', authTokens: [secrets.authToken] };
      const c = cfg.config as unknown as PlivoTenantConfig;
      const provider = new PlivoProvider({ authId: c.authId, authToken: secrets.authToken }, this.plivoSettings(c.callerIds ?? [], c.defaultCallerId ?? null, c.costCurrency ?? 'USD'));
      this.cache.set(tenantId, { key, provider, source: 'tenant', at: Date.now() });
      return { provider, source: 'tenant', authTokens: [secrets.authToken] };
    }
    if (this.platformPlivoConfigured()) {
      const cached = this.cache.get('__platform');
      const provider =
        cached?.provider ??
        new PlivoProvider({ authId: e.PLIVO_AUTH_ID!, authToken: e.PLIVO_AUTH_TOKEN! }, this.plivoSettings(e.PLIVO_CALLER_ID ? [e.PLIVO_CALLER_ID] : [], e.PLIVO_CALLER_ID ?? null, 'USD'));
      this.cache.set('__platform', { key: 'platform', provider, source: 'platform', at: Date.now() });
      return { provider, source: 'platform', authTokens: [e.PLIVO_AUTH_TOKEN!] };
    }
    if (e.ALLOW_MOCK_PROVIDER) return { provider: this.mock(), source: 'simulated', authTokens: [] };
    return { provider: null, source: 'none', authTokens: [] };
  }

  async forTenant(tenantId: string): Promise<TelephonyProvider> {
    const { provider } = await this.resolve(tenantId);
    if (!provider) {
      throw Errors.unavailable('TELEPHONY_NOT_CONFIGURED', 'Calling is not set up. An administrator must add Plivo credentials in Settings → Integrations.');
    }
    return provider;
  }

  /** Provider that owns an existing call (a tenant may switch providers between calls). */
  async forCall(tenantId: string, providerKind: string): Promise<TelephonyProvider> {
    if (providerKind === 'MOCK') return this.mock();
    const { provider } = await this.resolve(tenantId);
    if (!provider || provider.kind !== 'PLIVO') throw Errors.unavailable('TELEPHONY_NOT_CONFIGURED', 'The Plivo account for this call is no longer configured');
    return provider;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

@Global()
@Module({ providers: [TelephonyRegistry], exports: [TelephonyRegistry] })
export class TelephonyCoreModule {}
