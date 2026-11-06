-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('ORG_ADMIN', 'SUPERVISOR', 'AGENT');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('OFFLINE', 'READY', 'DIALING', 'ON_CALL', 'WRAP_UP', 'PAUSED');

-- CreateEnum
CREATE TYPE "CallingMode" AS ENUM ('BROWSER', 'PHONE');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'INTERESTED', 'FOLLOW_UP', 'CALLBACK', 'NOT_INTERESTED', 'CONVERTED', 'INVALID', 'DO_NOT_CALL', 'CLOSED');

-- CreateEnum
CREATE TYPE "LeadPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SuppressionChannel" AS ENUM ('ALL', 'VOICE', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('DO_NOT_CALL', 'OPT_OUT', 'WRONG_NUMBER', 'INVALID_NUMBER', 'REGULATORY', 'MANUAL');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'VALIDATING', 'PREVIEW_READY', 'IMPORTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueueItemState" AS ENUM ('WAITING', 'IN_PROGRESS', 'DONE', 'REMOVED');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('INITIATING', 'AGENT_RINGING', 'AGENT_CONNECTED', 'CUSTOMER_RINGING', 'CONNECTED', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LegRole" AS ENUM ('AGENT', 'CUSTOMER', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "LegStatus" AS ENUM ('QUEUED', 'INITIATED', 'RINGING', 'ANSWERED', 'COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TelephonyProviderKind" AS ENUM ('PLIVO', 'MOCK');

-- CreateEnum
CREATE TYPE "WrapUpStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'DONE', 'RECOVERED');

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('PROVIDER', 'ESTIMATE', 'NONE');

-- CreateEnum
CREATE TYPE "CallbackStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED', 'MISSED');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('PENDING', 'AVAILABLE', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "WaDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "WaStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WaPurpose" AS ENUM ('CALLBACK_CONFIRMATION', 'MISSED_CALL_FOLLOWUP', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('PLIVO', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'CONFIGURED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'PAYMENT', 'CREDIT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('VOICE_LEG_SECONDS', 'VOICE_COST', 'WHATSAPP_MESSAGE', 'LEAD_IMPORT', 'RECORDING_SECONDS');

-- CreateEnum
CREATE TYPE "OutcomeCategory" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'CONVERTED', 'NO_CONTACT', 'INVALID', 'DO_NOT_CALL');

-- CreateEnum
CREATE TYPE "RetryBehavior" AS ENUM ('NONE', 'RETRY', 'CALLBACK');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'LOGGED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedReason" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "timezone" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "teamId" UUID,
    "callingMode" "CallingMode",
    "agentPhoneE164" TEXT,
    "telephonyIdentity" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_supervisors" (
    "tenantId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,

    CONSTRAINT "team_supervisors_pkey" PRIMARY KEY ("teamId","membershipId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "membershipId" UUID,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "teamId" UUID,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "invitedByMembership" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_states" (
    "membershipId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'OFFLINE',
    "pauseReason" TEXT,
    "currentCallId" UUID,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "microphone" TEXT,
    "providerRegistered" BOOLEAN NOT NULL DEFAULT false,
    "deviceCheckedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agent_states_pkey" PRIMARY KEY ("membershipId")
);

-- CreateTable
CREATE TABLE "agent_status_history" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "status" "AgentStatus" NOT NULL,
    "reason" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "agent_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "email" TEXT,
    "propertyInterest" TEXT,
    "preferredLocation" TEXT,
    "budgetMin" BIGINT,
    "budgetMax" BIGINT,
    "source" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "priority" "LeadPriority" NOT NULL DEFAULT 'NORMAL',
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "consentSource" TEXT,
    "consentCapturedAt" TIMESTAMPTZ(3),
    "consentEvidence" TEXT,
    "assignedMembershipId" UUID,
    "lastCallAt" TIMESTAMPTZ(3),
    "lastCallOutcome" TEXT,
    "nextCallbackAt" TIMESTAMPTZ(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "importJobId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "authorMembershipId" UUID,
    "callId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actorMembershipId" UUID,
    "data" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "fromMembershipId" UUID,
    "toMembershipId" UUID,
    "assignedByMembershipId" UUID,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID,
    "phoneE164" TEXT NOT NULL,
    "channel" "SuppressionChannel" NOT NULL DEFAULT 'ALL',
    "status" "ConsentStatus" NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" TEXT,
    "capturedAt" TIMESTAMPTZ(3),
    "recordedByMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "channel" "SuppressionChannel" NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "note" TEXT,
    "source" TEXT,
    "createdByMembershipId" UUID,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_import_jobs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "headers" JSONB,
    "sampleRows" JSONB,
    "mapping" JSONB,
    "options" JSONB,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "suppressedRows" INTEGER NOT NULL DEFAULT 0,
    "existingRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "updatedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "errorSample" JSONB,
    "previewRows" JSONB,
    "failureReason" TEXT,
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validatedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "lead_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queues" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "callerId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_members" (
    "tenantId" UUID NOT NULL,
    "queueId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,

    CONSTRAINT "queue_members_pkey" PRIMARY KEY ("queueId","membershipId")
);

-- CreateTable
CREATE TABLE "queue_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "queueId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "state" "QueueItemState" NOT NULL DEFAULT 'WAITING',
    "priority" INTEGER NOT NULL DEFAULT 10,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMPTZ(3),
    "assignedMembershipId" UUID,
    "isCallback" BOOLEAN NOT NULL DEFAULT false,
    "callbackId" UUID,
    "reservedByMembershipId" UUID,
    "reservedAt" TIMESTAMPTZ(3),
    "doneReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "queueId" UUID,
    "queueItemId" UUID,
    "provider" "TelephonyProviderKind" NOT NULL,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "callingMode" "CallingMode" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'INITIATING',
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromNumber" TEXT,
    "toNumberE164" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "countedAsAttempt" BOOLEAN NOT NULL DEFAULT false,
    "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "initiatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentAnsweredAt" TIMESTAMPTZ(3),
    "customerRingingAt" TIMESTAMPTZ(3),
    "customerAnsweredAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "talkSeconds" INTEGER,
    "billableSeconds" INTEGER,
    "costMinor" BIGINT,
    "costCurrency" TEXT,
    "costSource" "CostSource" NOT NULL DEFAULT 'NONE',
    "failureReason" TEXT,
    "hangupCause" TEXT,
    "hangupSource" TEXT,
    "wrapUpStatus" "WrapUpStatus" NOT NULL DEFAULT 'PENDING',
    "lastEventAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_legs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "callId" UUID NOT NULL,
    "role" "LegRole" NOT NULL,
    "status" "LegStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" "TelephonyProviderKind" NOT NULL,
    "providerRequestId" TEXT,
    "providerCallId" TEXT,
    "toAddress" TEXT NOT NULL,
    "fromNumber" TEXT,
    "supervisorMembershipId" UUID,
    "coachMode" BOOLEAN,
    "everAnswered" BOOLEAN NOT NULL DEFAULT false,
    "initiatedAt" TIMESTAMPTZ(3),
    "ringingAt" TIMESTAMPTZ(3),
    "answeredAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "durationSeconds" INTEGER,
    "billSeconds" INTEGER,
    "costMinor" BIGINT,
    "costCurrency" TEXT,
    "costSource" "CostSource" NOT NULL DEFAULT 'NONE',
    "hangupCause" TEXT,
    "hangupCauseCode" TEXT,
    "hangupSource" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "call_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "callId" UUID,
    "legId" UUID,
    "provider" "TelephonyProviderKind" NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "signatureValid" BOOLEAN,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "processingError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "call_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcome_definitions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "OutcomeCategory" NOT NULL,
    "leadStatus" "LeadStatus",
    "requiresNotes" BOOLEAN NOT NULL DEFAULT false,
    "requiresCallback" BOOLEAN NOT NULL DEFAULT false,
    "retryBehavior" "RetryBehavior" NOT NULL DEFAULT 'NONE',
    "suppressReason" "SuppressionReason",
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "selectable" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 500,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outcome_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_outcomes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "callId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "outcomeCode" TEXT NOT NULL,
    "outcomeLabel" TEXT NOT NULL,
    "category" "OutcomeCategory" NOT NULL,
    "notes" TEXT,
    "callbackAt" TIMESTAMPTZ(3),
    "recordedBy" TEXT NOT NULL DEFAULT 'AGENT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "callbacks" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "sourceCallId" UUID,
    "assignedMembershipId" UUID,
    "createdByMembershipId" UUID,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "CallbackStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "reminderSentAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "completedCallId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recordings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "callId" UUID NOT NULL,
    "provider" "TelephonyProviderKind" NOT NULL,
    "providerRecordingId" TEXT NOT NULL,
    "status" "RecordingStatus" NOT NULL DEFAULT 'PENDING',
    "durationSeconds" INTEGER,
    "format" TEXT,
    "providerUrl" TEXT,
    "retentionUntil" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "deletedByMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "purpose" "WaPurpose" NOT NULL,
    "category" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID,
    "phoneE164" TEXT NOT NULL,
    "direction" "WaDirection" NOT NULL,
    "purpose" "WaPurpose",
    "templateId" UUID,
    "templateName" TEXT,
    "body" TEXT,
    "status" "WaStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdByMembershipId" UUID,
    "sentAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "readAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_configs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" "ProviderType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretsEncrypted" TEXT,
    "lastCheckedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "updatedByMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "monthlyPriceMinor" BIGINT NOT NULL,
    "annualPriceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "maxAgents" INTEGER NOT NULL,
    "maxLeadImportsPerMonth" INTEGER NOT NULL,
    "maxConcurrentCalls" INTEGER NOT NULL,
    "features" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "currentPeriodStart" TIMESTAMPTZ(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMPTZ(3) NOT NULL,
    "trialEndsAt" TIMESTAMPTZ(3),
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "paymentMode" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_ledger_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "periodStart" TIMESTAMPTZ(3),
    "periodEnd" TIMESTAMPTZ(3),
    "isSimulated" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "quantity" BIGINT NOT NULL,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "isEstimate" BOOLEAN NOT NULL DEFAULT false,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "actorUserId" UUID,
    "actorMembershipId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_telephonyIdentity_key" ON "memberships"("telephonyIdentity");

-- CreateIndex
CREATE INDEX "memberships_tenantId_role_status_idx" ON "memberships"("tenantId", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenantId_userId_key" ON "memberships"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_tenantId_name_key" ON "teams"("tenantId", "name");

-- CreateIndex
CREATE INDEX "team_supervisors_tenantId_membershipId_idx" ON "team_supervisors"("tenantId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "invitations_tenantId_email_idx" ON "invitations"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_userId_type_idx" ON "auth_tokens"("userId", "type");

-- CreateIndex
CREATE INDEX "email_outbox_createdAt_idx" ON "email_outbox"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_states_currentCallId_key" ON "agent_states"("currentCallId");

-- CreateIndex
CREATE INDEX "agent_states_tenantId_status_idx" ON "agent_states"("tenantId", "status");

-- CreateIndex
CREATE INDEX "agent_status_history_tenantId_membershipId_startedAt_idx" ON "agent_status_history"("tenantId", "membershipId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_status_history_tenantId_startedAt_idx" ON "agent_status_history"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "leads_tenantId_status_idx" ON "leads"("tenantId", "status");

-- CreateIndex
CREATE INDEX "leads_tenantId_assignedMembershipId_idx" ON "leads"("tenantId", "assignedMembershipId");

-- CreateIndex
CREATE INDEX "leads_tenantId_createdAt_idx" ON "leads"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "leads_tenantId_nextCallbackAt_idx" ON "leads"("tenantId", "nextCallbackAt");

-- CreateIndex
CREATE INDEX "leads_tenantId_lastCallAt_idx" ON "leads"("tenantId", "lastCallAt");

-- CreateIndex
CREATE UNIQUE INDEX "leads_tenantId_phoneE164_key" ON "leads"("tenantId", "phoneE164");

-- CreateIndex
CREATE INDEX "lead_notes_tenantId_leadId_createdAt_idx" ON "lead_notes"("tenantId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_activity_tenantId_leadId_createdAt_idx" ON "lead_activity"("tenantId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_assignments_tenantId_leadId_createdAt_idx" ON "lead_assignments"("tenantId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "consent_records_tenantId_phoneE164_idx" ON "consent_records"("tenantId", "phoneE164");

-- CreateIndex
CREATE INDEX "consent_records_tenantId_leadId_idx" ON "consent_records"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "suppression_entries_tenantId_createdAt_idx" ON "suppression_entries"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_entries_tenantId_phoneE164_channel_key" ON "suppression_entries"("tenantId", "phoneE164", "channel");

-- CreateIndex
CREATE INDEX "lead_import_jobs_tenantId_createdAt_idx" ON "lead_import_jobs"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "queues_tenantId_name_key" ON "queues"("tenantId", "name");

-- CreateIndex
CREATE INDEX "queue_members_tenantId_membershipId_idx" ON "queue_members"("tenantId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "queue_items_leadId_key" ON "queue_items"("leadId");

-- CreateIndex
CREATE INDEX "queue_items_tenantId_state_availableAt_idx" ON "queue_items"("tenantId", "state", "availableAt");

-- CreateIndex
CREATE INDEX "queue_items_tenantId_queueId_state_idx" ON "queue_items"("tenantId", "queueId", "state");

-- CreateIndex
CREATE INDEX "queue_items_tenantId_assignedMembershipId_state_idx" ON "queue_items"("tenantId", "assignedMembershipId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "calls_idempotencyKey_key" ON "calls"("idempotencyKey");

-- CreateIndex
CREATE INDEX "calls_tenantId_initiatedAt_idx" ON "calls"("tenantId", "initiatedAt");

-- CreateIndex
CREATE INDEX "calls_tenantId_membershipId_initiatedAt_idx" ON "calls"("tenantId", "membershipId", "initiatedAt");

-- CreateIndex
CREATE INDEX "calls_tenantId_status_idx" ON "calls"("tenantId", "status");

-- CreateIndex
CREATE INDEX "calls_tenantId_leadId_idx" ON "calls"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "calls_status_lastEventAt_idx" ON "calls"("status", "lastEventAt");

-- CreateIndex
CREATE INDEX "call_legs_tenantId_callId_idx" ON "call_legs"("tenantId", "callId");

-- CreateIndex
CREATE UNIQUE INDEX "call_legs_provider_providerRequestId_key" ON "call_legs"("provider", "providerRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "call_legs_provider_providerCallId_key" ON "call_legs"("provider", "providerCallId");

-- CreateIndex
CREATE INDEX "call_events_tenantId_callId_occurredAt_idx" ON "call_events"("tenantId", "callId", "occurredAt");

-- CreateIndex
CREATE INDEX "call_events_processedAt_receivedAt_idx" ON "call_events"("processedAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "call_events_provider_dedupeKey_key" ON "call_events"("provider", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "outcome_definitions_tenantId_code_key" ON "outcome_definitions"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "call_outcomes_callId_key" ON "call_outcomes"("callId");

-- CreateIndex
CREATE INDEX "call_outcomes_tenantId_createdAt_idx" ON "call_outcomes"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "call_outcomes_tenantId_outcomeCode_createdAt_idx" ON "call_outcomes"("tenantId", "outcomeCode", "createdAt");

-- CreateIndex
CREATE INDEX "callbacks_tenantId_status_dueAt_idx" ON "callbacks"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "callbacks_tenantId_assignedMembershipId_status_dueAt_idx" ON "callbacks"("tenantId", "assignedMembershipId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "recordings_tenantId_callId_idx" ON "recordings"("tenantId", "callId");

-- CreateIndex
CREATE INDEX "recordings_tenantId_retentionUntil_idx" ON "recordings"("tenantId", "retentionUntil");

-- CreateIndex
CREATE UNIQUE INDEX "recordings_provider_providerRecordingId_key" ON "recordings"("provider", "providerRecordingId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_tenantId_name_language_key" ON "whatsapp_templates"("tenantId", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_providerMessageId_key" ON "whatsapp_messages"("providerMessageId");

-- CreateIndex
CREATE INDEX "whatsapp_messages_tenantId_phoneE164_createdAt_idx" ON "whatsapp_messages"("tenantId", "phoneE164", "createdAt");

-- CreateIndex
CREATE INDEX "whatsapp_messages_tenantId_leadId_createdAt_idx" ON "whatsapp_messages"("tenantId", "leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_configs_tenantId_provider_key" ON "provider_configs"("tenantId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "subscriptions"("tenantId");

-- CreateIndex
CREATE INDEX "billing_ledger_entries_tenantId_createdAt_idx" ON "billing_ledger_entries"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_ledger_entries_tenantId_kind_occurredAt_idx" ON "usage_ledger_entries"("tenantId", "kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "usage_ledger_entries_kind_sourceType_sourceId_key" ON "usage_ledger_entries"("kind", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_action_createdAt_idx" ON "audit_logs"("tenantId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_tenantId_membershipId_readAt_createdAt_idx" ON "notifications"("tenantId", "membershipId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_supervisors" ADD CONSTRAINT "team_supervisors_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_supervisors" ADD CONSTRAINT "team_supervisors_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_states" ADD CONSTRAINT "agent_states_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activity" ADD CONSTRAINT "lead_activity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_legs" ADD CONSTRAINT "call_legs_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_outcomes" ADD CONSTRAINT "call_outcomes_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "callbacks" ADD CONSTRAINT "callbacks_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_callId_fkey" FOREIGN KEY ("callId") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
