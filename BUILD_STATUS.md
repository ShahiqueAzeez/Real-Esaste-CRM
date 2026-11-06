# Build status

Last updated: 6 November 2026.

**State: MVP feature-complete and tested end to end with simulated providers. Not yet verified
with a real Plivo account, a real WhatsApp number or real customers. Do not start a pilot before
the items under "Before a pilot" are done.**

## What exists

| Area | Status |
|---|---|
| Monorepo | `packages/shared` (domain rules), `apps/api` (NestJS API + worker, Prisma, 37 tables, 131 routes), `apps/web` (Next.js, 30 pages), Docker images, Compose stack, Caddy config. |
| Multi-tenancy and security | Session-derived tenant, permission guard, Prisma tenant guard, 404 on cross-tenant ids, Argon2id, DB sessions, CSRF, lockout, Redis rate limits, encrypted provider secrets, log redaction, audit log. |
| Roles | Platform admin, organisation admin, supervisor, agent (+ grantable extra permissions). |
| Leads | CRUD, search/filter/sort, bulk actions, notes, timeline, consent, CSV import with preview and error report, export. |
| Calling | Progressive, agent-first dialling with atomic reservation, idempotent dial, call/leg state machine, mandatory wrap-up, retries in calling windows, callbacks, suppression, attempt limits, recovery, stuck-call and stale-agent sweeps, provider-outage handling, caller-ID validation. |
| Telephony providers | Plivo adapter (calls, MPC XML, hangup/cancel, CDR, receive-only JWT, V3 signatures, coach mode) and a labelled simulated provider. |
| Supervisor | Live board, team metrics, whisper/barge (Plivo only). |
| Recordings | Metadata, proxied 5-minute signed playback, retention, deletion, audit. |
| WhatsApp | Cloud API adapter + simulated mode, templates, utility-only automations (off by default), consent/opt-out/frequency checks, signed webhooks. |
| Reports | Attempts vs answered vs connected, outcomes, agents, callbacks, usage, costs (provider vs estimate), CSV. |
| Plans and billing | Configurable plans (examples ₹7,999 / ₹14,999 / ₹24,999), trials, entitlements, manual billing ledger, usage ledger. No payment provider. |
| Platform | Tenants, plans, subscriptions, system health, integration failures, platform audit log. |
| Operations | Health endpoints, bootstrap/seed/example-plan scripts, backup/restore commands, runbooks, deployment guides. |

## Test results (6 November 2026)

| Suite | Result |
|---|---|
| Shared domain unit tests | 46 passed |
| API unit tests | 68 passed |
| API integration tests (real PostgreSQL 16 + Redis 7, simulated providers, signed webhook fixtures) | 32 passed |
| Playwright e2e against a freshly built local stack (`npm run test:e2e:stack`) | 5 passed |
| Same Playwright suite against the production Docker Compose stack (Caddy, read-only containers, `NODE_ENV=production`) | 5 passed |
| Typecheck (shared, API, web) and production builds | clean |
| Docker: both images build; all containers healthy; migrations applied by the one-shot service; WebSocket upgrades through Caddy return 101 | verified |
| Backups: `pg_dump` → restore into a scratch database (row counts checked); storage volume tar backup and restore | verified |

All telephony and WhatsApp behaviour in these results is **simulated**. No real call was placed and
no real message was sent.

## Verified versus unverified

| Item | Status |
|---|---|
| Plivo method names, parameters, XML attributes, V3 signature algorithm | Verified against the official SDK source (`plivo@4.79.0`, `plivo-browser-sdk@2.2.21`). plivo.com itself was blocked by the build environment's network policy. |
| Plivo `TotalCost` in hangup callbacks; MPC and recording callback field names | **Unverified**: parsed tolerantly; costs fall back to the CDR. |
| How Plivo addresses a JWT-registered browser user (`sip:<identity>@phone.plivo.com`); whether the token needs an application id | **Unverified**: configurable template; confirm in the smoke test. |
| `X-PH-*` custom header delivery to the browser | **Unverified**: the browser also accepts the single call announced over Socket.IO. |
| Browser (WebRTC) calling for India-region accounts (media anchoring, hangup 4590) | **Unverified**: confirm with Plivo; agent phone mode is the fallback. |
| WhatsApp template payloads and delivery webhooks against Meta | **Unverified**: fixture-tested only; body parameters mapped, header/button parameters not yet. |
| Default API image path (`node:22.23.4-bookworm-slim` + `apt-get install openssl`) | **Not exercised here**: the build environment blocks the Debian mirror, so the API image was built and tested with `NODE_IMAGE=node:22.23.4-bookworm` (same Debian release, OpenSSL preinstalled). On a normal network the default works as written. |

## Before a pilot (needs accounts, money or decisions only you can make)

1. **Plivo**: India-region account, KYC, a rented number suited to the purpose (140-series for
   promotional calls), DLT registration, recording URL authentication. Then run the smoke test in
   `docs/TELEPHONY_PLIVO.md` with approved test numbers and record the results below.
2. **Compliance review** with counsel: call classification, DND scrubbing approach, consent wording,
   recording notice, privacy notice, processing agreements (`docs/COMPLIANCE_INDIA.md`).
3. **Hosting**: domain, HTTPS host, SMTP (for example Amazon SES), backups copied off-site
   (`docs/DEPLOYMENT.md`). Nothing has been deployed publicly.
4. **WhatsApp** (optional): Meta Business verification, WhatsApp number, approved utility templates.
5. **Payments** (optional): choose a payment provider; until then billing entries are manual.

## Smoke test results

Not run: no Plivo account was available to this build. Record results here:

| Date | Step | Plivo call UUIDs | Result | Notes |
|---|---|---|---|---|
| | | | | |

## Known limitations

* No multi-factor authentication; no PostgreSQL row-level security (application guard + tests instead).
* No DND/NCPR scrubbing integration; the CRM enforces its own suppression list and consent flags.
* No payment collection; plan prices are shown and recorded, not charged.
* Predictive or power dialling is intentionally not implemented (progressive only).
* No automated re-encryption when rotating `DATA_ENCRYPTION_KEY`.
* WhatsApp header/button template parameters not mapped.
* Queue backlog and provider-event metrics are visible in the platform health page but not exported
  to a metrics system.
* No load test yet.

## Next steps (suggested order)

1. Plivo smoke test (browser mode and phone mode), then fix whatever the unverified items reveal.
2. MFA for organisation and platform admins.
3. DND scrubbing integration with the chosen operator or provider.
4. Metrics export (Prometheus/CloudWatch) and alerting on queue backlogs and stuck calls.
5. Payment provider integration if self-serve billing is wanted.
6. Load test with 50–100 simulated agents to size database pool and worker concurrency.
7. RLS as a database-level backstop for tenant isolation.
