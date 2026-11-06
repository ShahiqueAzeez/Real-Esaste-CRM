# Implementation checklist

Legend: `[x]` done and tested · `[~]` implemented, needs real-provider verification · `[ ]` not done.
`BUILD_STATUS.md` holds the current state, test results and known limitations.

## Phase 1 — Plan
- [x] Inspect repository (Westside Dentist static site + voice widget; CRM built in `calling-crm/`, existing site untouched)
- [x] Verify Plivo SDK methods, JWT browser login, signature V3, MPC coach mode from official SDK source
- [x] Document India constraints, blockers and smoke test (`docs/TELEPHONY_PLIVO.md`)
- [x] Architecture (`docs/ARCHITECTURE.md`), schema plan (`docs/DATABASE.md`), this checklist

## Phase 2 — Foundation
- [ ] npm workspaces: `packages/shared`, `apps/api`, `apps/web`
- [ ] Shared enums, permissions, settings, state machines, schemas (unit tested)
- [ ] Prisma schema + initial migration, indexes, seed (synthetic data only)
- [ ] Config validation, structured logging with redaction, error filter
- [ ] Auth: Argon2id, DB sessions, CSRF, lockout, invitations, verification, reset
- [ ] Tenant context, permission guard, Prisma tenant guard
- [ ] Socket.IO gateway + Redis fan-out; BullMQ worker process
- [ ] Next.js shell: login, role layouts, design tokens, UI kit
- [ ] Docker Compose (postgres, redis, api, worker, web, caddy)

## Phase 3 — Core CRM
- [ ] Leads CRUD/search/filter/sort/paginate, notes, timeline, bulk assign/status/queue, export (formula-safe)
- [ ] CSV import: upload → mapping → validation preview → batched import → error report
- [ ] Suppression list, consent records, eligibility rules
- [ ] Members, roles, teams, invitations, agent profiles
- [ ] Queues, queue membership, atomic reservation, retry scheduling
- [ ] Outcomes (configurable), wrap-up, callbacks, overdue tracking, reminders
- [ ] Admin overview + agent console

## Phase 4 — Telephony
- [ ] Provider adapter interface, provider registry per tenant
- [ ] Mock provider + simulator (clearly labelled)
- [~] Plivo provider: agent leg, customer leg, MPC XML, hangup/cancel, CDR, JWT token
- [ ] Signed webhook receivers (V3), idempotent event store, ordered state application
- [ ] Browser SDK wrapper with receive-only JWT and guarded auto-answer
- [ ] Agent phone mode fallback
- [ ] Stuck-call reconciliation, stale-agent sweep

## Phase 5 — Business features
- [ ] Supervisor live board, team metrics, whisper/barge via MPC coach mode (Plivo only)
- [ ] Recording metadata, signed short-lived playback via proxy, retention, deletion, access audit
- [ ] WhatsApp Cloud API adapter (+ mock), templates, consent/frequency checks, webhooks, opt-out
- [ ] Reports from persisted data, CSV export, provider vs estimated cost separation
- [ ] Plans, subscriptions, entitlements, billing ledger (manual/simulated), usage ledger
- [ ] Platform admin: tenants, plans, health, integration failures

## Phase 6 — Harden and document
- [ ] Unit, integration (real PostgreSQL/Redis) and Playwright e2e suites green
- [ ] Concurrency test for reservations, duplicate/out-of-order webhook tests, outage handling
- [ ] Production builds; deployment, backup/restore, troubleshooting, compliance docs
- [ ] `BUILD_STATUS.md` complete with limitations and next steps
