import * as shared from '@crm/shared';
import { $Enums } from '@prisma/client';

/** The shared package mirrors Prisma enums for the browser; they must never drift. */
describe('enum parity between @crm/shared and Prisma', () => {
  const pairs: [string, Record<string, string>, Record<string, string>][] = [
    ['MembershipRole', shared.MembershipRole, $Enums.MembershipRole],
    ['AgentStatus', shared.AgentStatus, $Enums.AgentStatus],
    ['CallingMode', shared.CallingMode, $Enums.CallingMode],
    ['LeadStatus', shared.LeadStatus, $Enums.LeadStatus],
    ['LeadPriority', shared.LeadPriority, $Enums.LeadPriority],
    ['ConsentStatus', shared.ConsentStatus, $Enums.ConsentStatus],
    ['SuppressionChannel', shared.SuppressionChannel, $Enums.SuppressionChannel],
    ['SuppressionReason', shared.SuppressionReason, $Enums.SuppressionReason],
    ['ImportStatus', shared.ImportStatus, $Enums.ImportStatus],
    ['QueueItemState', shared.QueueItemState, $Enums.QueueItemState],
    ['CallStatus', shared.CallStatus, $Enums.CallStatus],
    ['LegRole', shared.LegRole, $Enums.LegRole],
    ['LegStatus', shared.LegStatus, $Enums.LegStatus],
    ['WrapUpStatus', shared.WrapUpStatus, $Enums.WrapUpStatus],
    ['CostSource', shared.CostSource, $Enums.CostSource],
    ['CallbackStatus', shared.CallbackStatus, $Enums.CallbackStatus],
    ['RecordingStatus', shared.RecordingStatus, $Enums.RecordingStatus],
    ['WaStatus', shared.WaStatus, $Enums.WaStatus],
    ['WaPurpose', shared.WaPurpose, $Enums.WaPurpose],
    ['SubscriptionStatus', shared.SubscriptionStatus, $Enums.SubscriptionStatus],
    ['OutcomeCategory', shared.OutcomeCategory, $Enums.OutcomeCategory],
    ['RetryBehavior', shared.RetryBehavior, $Enums.RetryBehavior],
    ['UsageKind', shared.UsageKind, $Enums.UsageKind],
  ];
  it.each(pairs)('%s matches', (_name, a, b) => {
    expect(Object.values(a).sort()).toEqual(Object.values(b).sort());
  });
});
