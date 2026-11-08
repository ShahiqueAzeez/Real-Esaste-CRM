# Implementation checklist

Legend: `[x]` done and covered by automated tests or verified by running it · `[~]` implemented,
needs verification with a real provider account · `[ ]` not done.
`BUILD_STATUS.md` holds the current state, test results and known limitations.

## Phase 1 — Plan
- [x] Standalone repository: npm workspaces monorepo at the repository root
- [x] Verify Plivo SDK methods, JWT browser login, signature V3, MPC coach mode from official SDK source
- [x] Document India constraints, blockers and smoke test (`docs/TELEPHONY_PLIVO.md`, `docs/COMPLIANCE_INDIA.md`)
- [x] Architecture (`docs/ARCHITECTURE.md`), schema (`docs/DATABASE.md`), this checklist

## Phase 2 — Foundation
- [x] npm workspaces: `packages/shared`, `apps/api`, `apps/web`
- [x] Shared enums, permissions, settings, state machines, schemas (unit tested)
- [x] Prisma schema + migrations, indexes, development seed (synthetic data only), bootstrap and example-plan scripts
- [x] Config validation, structured logging with redaction, error filter with request ids
- [x] Auth: Argon2id, DB sessions, CSRF, lockout, rate limits, invitations, verification, reset
- [x] Tenant context, permission guard, Prisma tenant guard
- [x] Socket.IO gateway + Redis fan-out; BullMQ worker process
- [x] Next.js shell: login, role layouts, design tokens, UI kit
- [x] Docker images and Compose stack (postgres, redis, migrate, api, worker, web, caddy), built and run end to end

## Phase 3 — Core CRM
- [x] Leads CRUD/search/filter/sort/paginate, notes, timeline, bulk assign/status/queue, export (formula-safe)
- [x] CSV import: upload → mapping → validation preview → batched import → error report
- [x] Suppression list, consent records, eligibility rules
- [x] Members, roles, teams, invitations, agent profiles
- [x] Queues, queue membership, atomic reservation, retry scheduling, caller-ID validation
- [x] Outcomes (configurable), wrap-up, callbacks, overdue tracking, reminders
- [x] Admin overview + agent console

## Phase 4 — Telephony
- [x] Provider adapter interface, provider registry per tenant (tenant account → platform account → simulated)
- [x] Mock provider + simulator (clearly labelled)
- [~] Plivo provider: agent leg, customer leg, MPC XML, hangup/cancel, CDR, JWT token (SDK-verified, fixture-tested; no real call placed)
- [x] Signed webhook receivers (V3), idempotent event store, ordered state application (tested with signed fixtures)
- [~] Browser SDK wrapper with receive-only JWT and guarded auto-answer (needs a real Plivo account and browser)
- [~] Agent phone mode (same adapter path; needs a real call)
- [x] Stuck-call reconciliation, stale-agent sweep, provider-outage handling

## Phase 5 — Business features
- [x] Supervisor live board and team metrics
- [~] Whisper/barge via MPC coach mode (Plivo only; disabled for simulated calls)
- [~] Recording metadata, signed short-lived playback via proxy, retention, deletion, access audit (real Plivo recording callbacks unverified)
- [~] WhatsApp Cloud API adapter (+ mock), templates, consent/frequency checks, webhooks, opt-out (fixture-tested; no real message sent)
- [x] Reports from persisted data, CSV export, provider vs estimated cost separation
- [x] Plans, subscriptions, entitlements, billing ledger (manual/simulated), usage ledger
- [x] Platform admin: tenants, plans, health, integration failures

## Phase 6 — Harden and document
- [x] Unit, integration (real PostgreSQL/Redis) and Playwright e2e suites green
- [x] Concurrency test for reservations, duplicate/out-of-order webhook tests, agent-line failure and provider-outage tests
- [x] Production builds (Docker images; e2e suite passes against the production containers)
- [x] Deployment, backup/restore (commands tested), operations, security, compliance, WhatsApp, testing docs
- [x] `BUILD_STATUS.md` complete with limitations and next steps
- [ ] Real-provider smoke test (requires an India-region Plivo account, KYC and approved test numbers)
