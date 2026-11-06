'use client';

export type PhoneState = 'idle' | 'loading' | 'registering' | 'registered' | 'failed' | 'unsupported';
export type PhoneCallState = 'incoming' | 'answered' | 'media' | 'ended' | 'failed' | 'rejected';

interface PlivoClient {
  on(event: string, handler: (...args: unknown[]) => void): void;
  loginWithAccessTokenGenerator(generator: { getAccessToken(): Promise<string> }): boolean;
  answer(callUUID?: string, actionOnOtherIncomingCalls?: string): boolean;
  reject(callUUID?: string): boolean;
  hangup(): boolean;
  mute(): boolean;
  unmute(): boolean;
  logout(): boolean;
}

/**
 * Plivo Browser SDK wrapper for agents and coaching supervisors.
 * - Registers with a receive-only JWT from our API (`incoming_allow` only); it never dials out.
 * - Auto-answers only a call the server announced over Socket.IO in the last 45 s, and, when the
 *   SIP header is present, only if it carries that call id. Anything else is rejected.
 */
export class BrowserPhone {
  private client: PlivoClient | null = null;
  private expected: { callId: string; expiresAt: number } | null = null;
  state: PhoneState = 'idle';

  constructor(
    private readonly onState: (state: PhoneState, message?: string) => void,
    private readonly onCall: (state: PhoneCallState, detail?: string) => void,
  ) {}

  private set(state: PhoneState, message?: string) {
    this.state = state;
    this.onState(state, message);
  }

  async start(getToken: () => Promise<string>): Promise<void> {
    if (typeof window === 'undefined') return;
    if (!('RTCPeerConnection' in window) || !navigator.mediaDevices) {
      this.set('unsupported', 'This browser cannot place WebRTC calls. Use a current Chrome, Edge or Firefox.');
      return;
    }
    this.set('loading');
    try {
      const mod = (await import('plivo-browser-sdk')) as unknown as { default?: new (o: object) => { client: PlivoClient } };
      const Plivo = (mod.default ?? mod) as unknown as new (o: object) => { client: PlivoClient };
      const sdk = new Plivo({ debug: 'ERROR', permOnClick: true, enableTracking: false, closeProtection: true, allowMultipleIncomingCalls: false });
      const c = sdk.client;
      this.client = c;
      c.on('onLogin', () => this.set('registered'));
      c.on('onLoginFailed', (reason) => this.set('failed', `Calling service sign-in failed (${String(reason ?? 'unknown')}).`));
      c.on('onLogout', () => this.set('idle'));
      c.on('onPermissionDenied', () => this.set('failed', 'Microphone access was denied. Allow it in the browser settings.'));
      c.on('onWebrtcNotSupported', () => this.set('unsupported', 'WebRTC is not supported in this browser.'));
      c.on('onIncomingCall', (_callerName, extraHeaders, callInfo) => this.incoming(extraHeaders as Record<string, string> | undefined, callInfo as { callUUID?: string } | undefined));
      c.on('onIncomingCallCanceled', () => this.onCall('ended'));
      c.on('onCallAnswered', () => this.onCall('answered'));
      c.on('onMediaConnected', () => this.onCall('media'));
      c.on('onCallTerminated', () => this.onCall('ended'));
      c.on('onCallFailed', (cause) => this.onCall('failed', String(cause ?? '')));
      this.set('registering');
      c.loginWithAccessTokenGenerator({ getAccessToken: getToken });
    } catch (err) {
      this.set('failed', `Could not load the calling service: ${(err as Error).message}`);
    }
  }

  /** Called when the server announces it is about to ring this browser for `callId`. */
  expect(callId: string, expiresAt: string): void {
    this.expected = { callId, expiresAt: Date.parse(expiresAt) };
  }

  private incoming(headers: Record<string, string> | undefined, info: { callUUID?: string } | undefined) {
    const uuid = info?.callUUID ?? undefined;
    const headerKey = headers ? Object.keys(headers).find((k) => /crmcallid$/i.test(k)) : undefined;
    const headerId = headerKey ? headers![headerKey] : undefined;
    const exp = this.expected;
    const ok = !!exp && exp.expiresAt > Date.now() && (!headerId || headerId === exp.callId);
    if (ok) {
      this.expected = null;
      this.onCall('incoming');
      this.client?.answer(uuid, 'reject');
    } else {
      this.client?.reject(uuid);
      this.onCall('rejected', 'Rejected an unexpected incoming call');
    }
  }

  hangup(): void {
    try {
      this.client?.hangup();
    } catch {
      /* already ended */
    }
  }

  setMuted(muted: boolean): void {
    try {
      if (muted) this.client?.mute();
      else this.client?.unmute();
    } catch {
      /* no active call */
    }
  }

  stop(): void {
    try {
      this.client?.logout();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.set('idle');
  }
}
