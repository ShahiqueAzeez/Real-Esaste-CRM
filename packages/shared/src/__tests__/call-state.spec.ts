import { applyLegEvent, deriveCallStatus, type LegSnapshot } from '../call-state';
import type { LegStatus } from '../enums';

const snap = (status: LegStatus, answered = status === 'ANSWERED' || status === 'COMPLETED'): LegSnapshot => ({ status, answered });

describe('applyLegEvent', () => {
  it('moves forward through the normal lifecycle', () => {
    expect(applyLegEvent('QUEUED', { type: 'INITIATED' }).status).toBe('INITIATED');
    expect(applyLegEvent('INITIATED', { type: 'RINGING' }).status).toBe('RINGING');
    expect(applyLegEvent('RINGING', { type: 'ANSWERED' }).status).toBe('ANSWERED');
    expect(applyLegEvent('ANSWERED', { type: 'ENDED', endStatus: 'COMPLETED' }).status).toBe('COMPLETED');
  });

  it('ignores duplicate and stale events', () => {
    expect(applyLegEvent('ANSWERED', { type: 'RINGING' })).toEqual({ status: 'ANSWERED', changed: false, ignoredReason: 'stale' });
    expect(applyLegEvent('RINGING', { type: 'RINGING' })).toMatchObject({ changed: false, ignoredReason: 'same_state' });
  });

  it('treats terminal states as absorbing', () => {
    expect(applyLegEvent('COMPLETED', { type: 'ANSWERED' })).toMatchObject({ status: 'COMPLETED', changed: false, ignoredReason: 'already_terminal' });
    expect(applyLegEvent('BUSY', { type: 'ENDED', endStatus: 'COMPLETED' })).toMatchObject({ status: 'BUSY', changed: false });
  });

  it('maps an answered leg ending with any status to COMPLETED', () => {
    expect(applyLegEvent('ANSWERED', { type: 'ENDED', endStatus: 'NO_ANSWER' }).status).toBe('COMPLETED');
  });

  it('maps a COMPLETED end without an answer to NO_ANSWER', () => {
    expect(applyLegEvent('RINGING', { type: 'ENDED', endStatus: 'COMPLETED' }).status).toBe('NO_ANSWER');
  });

  it('allows an end event to skip intermediate states (out of order delivery)', () => {
    expect(applyLegEvent('INITIATED', { type: 'ENDED', endStatus: 'BUSY' }).status).toBe('BUSY');
  });
});

describe('deriveCallStatus', () => {
  it('follows the agent leg before the customer leg exists', () => {
    expect(deriveCallStatus('INITIATING', snap('RINGING'), null)).toBe('AGENT_RINGING');
    expect(deriveCallStatus('AGENT_RINGING', snap('ANSWERED'), null)).toBe('AGENT_CONNECTED');
  });

  it('fails the call when the agent leg never answers', () => {
    expect(deriveCallStatus('AGENT_RINGING', snap('NO_ANSWER', false), null)).toBe('FAILED');
  });

  it('cancels when the agent hangs up before the customer leg starts', () => {
    expect(deriveCallStatus('AGENT_CONNECTED', snap('COMPLETED', true), null)).toBe('CANCELLED');
  });

  it('only reports CONNECTED once the customer answers', () => {
    expect(deriveCallStatus('AGENT_CONNECTED', snap('ANSWERED'), snap('INITIATED', false))).toBe('AGENT_CONNECTED');
    expect(deriveCallStatus('AGENT_CONNECTED', snap('ANSWERED'), snap('RINGING', false))).toBe('CUSTOMER_RINGING');
    expect(deriveCallStatus('CUSTOMER_RINGING', snap('ANSWERED'), snap('ANSWERED'))).toBe('CONNECTED');
  });

  it('maps customer no-answer, busy and failure', () => {
    expect(deriveCallStatus('CUSTOMER_RINGING', snap('ANSWERED'), snap('BUSY', false))).toBe('BUSY');
    expect(deriveCallStatus('CUSTOMER_RINGING', snap('ANSWERED'), snap('NO_ANSWER', false))).toBe('NO_ANSWER');
    expect(deriveCallStatus('CUSTOMER_RINGING', snap('ANSWERED'), snap('FAILED', false))).toBe('FAILED');
  });

  it('completes when either side hangs up after a connection', () => {
    expect(deriveCallStatus('CONNECTED', snap('ANSWERED'), snap('COMPLETED', true))).toBe('COMPLETED');
    expect(deriveCallStatus('CONNECTED', snap('COMPLETED', true), snap('ANSWERED'))).toBe('COMPLETED');
  });

  it('cancels when the agent drops while the customer is ringing', () => {
    expect(deriveCallStatus('CUSTOMER_RINGING', snap('COMPLETED', true), snap('RINGING', false))).toBe('CANCELLED');
  });

  it('never moves backwards and keeps terminal states', () => {
    expect(deriveCallStatus('CONNECTED', snap('ANSWERED'), snap('RINGING', false))).toBe('CONNECTED');
    expect(deriveCallStatus('COMPLETED', snap('ANSWERED'), snap('ANSWERED'))).toBe('COMPLETED');
  });
});
