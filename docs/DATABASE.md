# Database

PostgreSQL 16, accessed through Prisma 6 (`apps/api/prisma/schema.prisma`). One shared schema for
all tenants; every tenant-owned table has a `tenant_id` column and every query from request code is
checked for it (see `docs/SECURITY.md`).

## Conventions

* UUID primary keys (`@db.Uuid`), `timestamptz(3)` timestamps, snake_case table names via `@@map`.
* Money is stored as integers: plan prices and ledger entries in **minor units** (paise for INR),
  provider call costs in **micro-units** (`cost_micros`, millionths of the currency unit) with an
  explicit `cost_currency`. Floats are never used for money.
* Phone numbers are stored normalised to E.164 (`phone_e164`).
* Enumerations are PostgreSQL enums mirrored in `packages/shared/src/enums.ts`; a unit test
  (`apps/api/src/common/enum-sync.spec.ts`) fails if the two drift apart.
* Flexible but validated settings live in JSON columns (`tenants.settings`, `plans.features`,
  `provider_configs.config`) and are parsed with Zod schemas from `packages/shared` on every read.

## Tables by area

| Area | Tables | Notes |
|---|---|---|
| Identity | `users`, `sessions`, `auth_tokens`, `invitations`, `email_outbox` | Users are global (one login, several organisations). Session, invitation and reset tokens are stored as SHA-256 hashes. |
| Tenancy | `tenants`, `memberships`, `teams`, `team_supervisors` | `memberships` (unique per tenant + user) carries the role (`ORG_ADMIN`, `SUPERVISOR`, `AGENT`), extra permissions, calling mode and the Plivo browser identity. |
| Agents | `agent_states`, `agent_status_history` | One live state row per membership (`current_call_id` unique) plus an append-only history used for productivity reports. |
| Leads | `leads`, `lead_notes`, `lead_activity`, `lead_assignments`, `consent_records`, `suppression_entries`, `lead_import_jobs` | `leads` is unique on (tenant, phone). `suppression_entries` is unique on (tenant, phone, channel). Activity is an append-only timeline. |
| Queues | `queues`, `queue_members`, `queue_items` | One queue item per lead (`lead_id` unique). Reservation uses `SELECT … FOR UPDATE SKIP LOCKED` on `queue_items` indexed by (tenant, state, available_at). |
| Calls | `calls`, `call_legs`, `call_events`, `call_outcomes`, `outcome_definitions`, `callbacks`, `recordings` | `calls.idempotency_key` is unique (dial-next retries). `call_legs` is unique on (provider, provider_request_id) and (provider, provider_call_id) so callbacks map to exactly one leg. `call_events` is unique on (provider, dedupe_key): a re-delivered webhook is stored once. One outcome per call (`call_outcomes.call_id` unique). |
| Messaging | `whatsapp_templates`, `whatsapp_messages` | `provider_message_id` unique so status webhooks update one row. |
| Integrations | `provider_configs` | One row per tenant and provider. Non-secret config in JSON, secrets AES-256-GCM encrypted in `secrets_encrypted`. |
| Billing | `plans`, `subscriptions`, `billing_ledger_entries`, `usage_ledger_entries` | One subscription per tenant. Usage entries are unique on (kind, source type, source id) so usage is never double counted. Ledger entries are append-only. |
| Platform | `audit_logs`, `notifications` | Audit rows have a nullable tenant (platform actions). |

## Important indexes

* Dialler: `queue_items (tenant_id, state, available_at)`, `(tenant_id, assigned_membership_id, state)`;
  `callbacks (tenant_id, assigned_membership_id, status, due_at)`.
* Webhook processing: unique `call_events (provider, dedupe_key)`, `call_legs` provider identifiers,
  `calls (status, last_event_at)` for the stuck-call sweep, `call_events (processed_at, received_at)`
  for the pending-event sweep.
* Reports: `calls (tenant_id, initiated_at)`, `(tenant_id, membership_id, initiated_at)`,
  `call_outcomes (tenant_id, outcome_code, created_at)`, `agent_status_history (tenant_id, started_at)`.
* Lead lists: `leads (tenant_id, status)`, `(tenant_id, assigned_membership_id)`,
  `(tenant_id, created_at)`, `(tenant_id, next_callback_at)`, `(tenant_id, last_call_at)`.
* Retention: `recordings (tenant_id, retention_until)`, `sessions (expires_at)`.

## Migrations

Migrations live in `apps/api/prisma/migrations` and are applied with `prisma migrate deploy`, which
only runs pending migrations and never resets data.

```bash
# development: create a migration after editing schema.prisma
npm run db:migrate -- --name describe_the_change
```

```bash
# any environment: apply pending migrations
npm run db:deploy
```

```bash
# Docker Compose: the one-shot "migrate" service runs on every `docker compose up`
docker compose run --rm migrate
```

Write migrations that are safe while the previous API version is still running (add columns as
nullable or with defaults, backfill, then tighten in a later release).

## Seed data and first administrator

* `npm run db:seed` (development only) creates the example plans and a demo organisation, "Demo
  Realty Chennai", with an admin, a supervisor, two agents and 40 **synthetic** leads tagged with a
  synthetic source. Real providers refuse to dial synthetic leads. The seed refuses to run with
  `NODE_ENV=production`.
* `bootstrap-admin --email … [--with-example-plans]` creates the first platform administrator (and
  optionally the example plans) on any environment. There is no default administrator account.
* `example-plans` adds the Starter (₹7,999/month), Professional (₹14,999) and Business (₹24,999)
  example plans if missing; edit or replace them under Platform → Plans.

## Backups and restore

See `docs/OPERATIONS.md` for the tested `pg_dump`/`pg_restore` commands and `docs/DEPLOYMENT.md`
for managed backups on AWS RDS. Back up the recording/import storage (Docker volume or S3 bucket)
together with the database, and keep `DATA_ENCRYPTION_KEY` with the backups' key material: without
it, stored provider credentials cannot be decrypted after a restore.
